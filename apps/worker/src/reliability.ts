import { and, type Database, eq, gte, llmCalls, lt, runs, scans, sql, systemState } from "@teire/db";
import { RUNS } from "@teire/engine/constants";
import type { GitHubApp } from "@teire/engine/github";
import { createTokenFactory, modelHealth, ping, tokenFactoryConfigFromEnv } from "@teire/engine/llm";

/**
 * Reliability (plan S10): what keeps runs honest when the worker, the model service or the money
 * stops. A run without a heartbeat is failed cleanly (and retried by its queue); a Token Factory
 * 402 pauses model work until a ping succeeds; a daily spend cap defers runs with a clear reason;
 * webhook deliveries GitHub could not hand over are redelivered. State lives in `system_state` and
 * the /trust page shows it.
 */
export const RELIABILITY = {
  tickMs: 60_000,
  /** A scan stuck in "running" this long was cut off with its worker. */
  scanStaleAfterMs: 45 * 60_000,
  /** How often a 402 state is re-checked with a ping. */
  creditsRecheckMs: 15 * 60_000,
  /** Daily model spend cap (USD) when TEIRE_DAILY_COST_CAP_USD is unset. */
  defaultDailyCapUsd: 10,
  redeliveryEveryMs: 10 * 60_000,
  redeliveryWindowMs: 6 * 3600_000,
} as const;

export async function getState<T>(db: Database, key: string): Promise<T | null> {
  const [row] = await db.select().from(systemState).where(eq(systemState.key, key)).limit(1);
  return (row?.value as T) ?? null;
}

export async function setState(db: Database, key: string, value: unknown) {
  await db
    .insert(systemState)
    .values({ key, value })
    .onConflictDoUpdate({ target: systemState.key, set: { value, updatedAt: new Date() } });
}

export interface CreditsState {
  exhausted: boolean;
  since: string;
  detail: string;
  checkedAt: string;
}

export async function markCreditsExhausted(db: Database, detail: string) {
  const now = new Date().toISOString();
  const prior = await getState<CreditsState>(db, "credits");
  await setState(db, "credits", {
    exhausted: true,
    since: prior?.exhausted ? prior.since : now,
    detail: detail.slice(0, 300),
    checkedAt: now,
  } satisfies CreditsState);
}

/** Why model work must wait right now, or null: credits gone, or today's spend at the cap. */
export async function modelWorkBlocked(db: Database) {
  const credits = await getState<CreditsState>(db, "credits");
  if (credits?.exhausted)
    return `Token Factory credits are exhausted (since ${credits.since.slice(0, 16).replace("T", " ")} UTC); runs resume when they are topped up.`;
  const cap = Number(process.env.TEIRE_DAILY_COST_CAP_USD ?? RELIABILITY.defaultDailyCapUsd);
  const [row] = await db
    .select({ spent: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)` })
    .from(llmCalls)
    .where(gte(llmCalls.createdAt, new Date(Date.now() - 24 * 3600_000)));
  const spent = Number(row?.spent ?? 0);
  if (cap > 0 && spent >= cap)
    return `The daily model budget ($${cap.toFixed(2)}) is used up ($${spent.toFixed(2)} in the last 24 h); runs resume as it frees.`;
  return null;
}

/** Runs and scans whose worker stopped: failed with a clear reason, so they can be retried. */
export async function reap(db: Database) {
  const staleRuns = await db
    .update(runs)
    .set({
      status: "failed",
      step: "interrupted",
      error: "the worker stopped during this run; it is retried automatically, or comment `@teire recreate`",
      finishedAt: new Date(),
    })
    .where(and(eq(runs.status, "running"), lt(runs.heartbeatAt, new Date(Date.now() - RUNS.staleAfterMs))))
    .returning({ id: runs.id });
  const staleScans = await db
    .update(scans)
    .set({ status: "failed", error: "the worker stopped during this scan", finishedAt: new Date() })
    .where(
      and(
        eq(scans.status, "running"),
        lt(scans.startedAt, new Date(Date.now() - RELIABILITY.scanStaleAfterMs)),
      ),
    )
    .returning({ id: scans.id });
  return { runs: staleRuns.length, scans: staleScans.length };
}

/** Re-delivers webhook deliveries GitHub recorded as failed (the web route was down or slow). */
export async function sweepRedeliveries(gh: GitHubApp, db: Database) {
  const since = Date.now() - RELIABILITY.redeliveryWindowMs;
  const { data } = await gh.app.octokit.request("GET /app/hook/deliveries", { per_page: 100 });
  const failed = (
    data as { id: number; guid: string; status_code: number; delivered_at: string; redelivery: boolean }[]
  ).filter((d) => Date.parse(d.delivered_at) >= since && (d.status_code < 200 || d.status_code >= 300));
  let redelivered = 0;
  for (const d of failed) {
    // A guid that later arrived (a redelivery that worked) is already in the outbox.
    const { rows } = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from webhook_deliveries where guid = ${d.guid}`,
    );
    if ((rows[0]?.n ?? 0) > 0) continue;
    await gh.app.octokit
      .request("POST /app/hook/deliveries/{delivery_id}/attempts", { delivery_id: d.id })
      .catch(() => undefined);
    redelivered++;
  }
  await setState(db, "redelivery", { at: new Date().toISOString(), failed: failed.length, redelivered });
  return redelivered;
}

/** The worker's periodic tick: heartbeat, reaper, credit re-check, model health, redeliveries. */
export function startTicker(db: Database, gh: GitHubApp | null, version: string) {
  let lastRedelivery = 0;
  const tick = async () => {
    await setState(db, "worker", { at: new Date().toISOString(), version });
    const reaped = await reap(db);
    if (reaped.runs || reaped.scans)
      console.log(`[reaper] failed ${reaped.runs} run(s), ${reaped.scans} scan(s) without a heartbeat`);
    await setState(db, "models", { at: new Date().toISOString(), unhealthy: modelHealth() });
    const credits = await getState<CreditsState>(db, "credits");
    if (credits?.exhausted && Date.now() - Date.parse(credits.checkedAt) > RELIABILITY.creditsRecheckMs) {
      try {
        await ping(createTokenFactory(tokenFactoryConfigFromEnv()), "reader");
        await setState(db, "credits", { ...credits, exhausted: false, checkedAt: new Date().toISOString() });
        console.log("[credits] Token Factory answers again; model work resumes");
      } catch (error) {
        await setState(db, "credits", {
          ...credits,
          checkedAt: new Date().toISOString(),
          detail: String(error).slice(0, 300),
        });
      }
    }
    if (gh && Date.now() - lastRedelivery > RELIABILITY.redeliveryEveryMs) {
      lastRedelivery = Date.now();
      const n = await sweepRedeliveries(gh, db).catch((error) => {
        console.warn("[redelivery]", error instanceof Error ? error.message : error);
        return 0;
      });
      if (n) console.log(`[redelivery] asked GitHub to redeliver ${n} failed delivery(ies)`);
    }
  };
  const timer = setInterval(
    () => void tick().catch((error) => console.error("[tick]", error)),
    RELIABILITY.tickMs,
  );
  void tick().catch((error) => console.error("[tick]", error));
  return () => clearInterval(timer);
}
