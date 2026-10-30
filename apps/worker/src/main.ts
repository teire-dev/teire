import { createServer } from "node:http";
import { resolve } from "node:path";
import { createDb, createLocalDb, runMigrations, sql, tlsOptions } from "@teire/db";
import { CONTRIBUTED } from "@teire/engine/catalog";
import { RUNS } from "@teire/engine/constants";
import { createGitHubApp, githubAppConfigFromEnv } from "@teire/engine/github";
import { CreditsExhaustedError } from "@teire/engine/llm";
import { PgBoss } from "pg-boss";
import { handleDelivery, reconcileInstallation } from "./jobs/events";
import { fixRun } from "./jobs/fix";
import { publicScan } from "./jobs/public";
import { reverifyRun } from "./jobs/reverify";
import { scanRepo } from "./jobs/scan";
import { startOutbox } from "./outbox";
import { ensureQueues, QUEUES } from "./queues";
import { markCreditsExhausted, startTicker } from "./reliability";
import { getRun, upsertChange } from "./store";

const PORT = Number(process.env.PORT ?? 8080);
const databaseUrl = process.env.DATABASE_URL;
const caCert = process.env.DATABASE_CA_CERT;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");
// TLS with a pinned CA everywhere, except a database on this machine (running Teire locally).
const local = !caCert && /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl);
if (!caCert && !local)
  throw new Error("DATABASE_CA_CERT is not set (only a localhost database may go without TLS)");

const { db, pool } = caCert
  ? createDb({ connectionString: databaseUrl, caCert })
  : createLocalDb(databaseUrl, 10);
const boss = new PgBoss({
  connectionString: databaseUrl,
  ...(caCert ? { ssl: tlsOptions(caCert) } : {}),
  schema: "pgboss",
});
boss.on("error", (error) => console.error("[pg-boss]", error));

const startedAt = new Date();

/** /live: the process answers (Coolify container health). /health: dependencies answer. */
const server = createServer(async (req, res) => {
  if (req.url === "/live") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/health") {
    const checks: Record<string, string> = {};
    try {
      await db.execute(sql`select 1`);
      checks.database = "ok";
    } catch (error) {
      checks.database = error instanceof Error ? error.message : "failed";
    }
    const ok = Object.values(checks).every((v) => v === "ok");
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok, checks, startedAt }));
    return;
  }
  res.writeHead(404).end();
});

/** In the image MIGRATIONS_DIR is an absolute path; in dev it is the db package folder. */
/** When the worker fails jobs a replaced container left active (after Coolify's overlap window). */
const STALE_JOB_SWEEP_MS = 3 * 60_000;
/**
 * How often failed scan and fix jobs are sent back. key_strict_fifo holds every later job of a
 * repository behind a failed one, and the handlers never throw, so a failed job only ever means it
 * expired or a sweep failed it; the run and scan rows decide whether any work is left.
 */
const UNBLOCK_MS = 5 * 60_000;

const migrationsDir = process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), "../../packages/db/drizzle");

async function main() {
  await runMigrations(db, migrationsDir);
  console.log("[worker] migrations applied");
  // Contributed catalog records (C13) are merged on every deploy; an unchanged one writes nothing.
  for (const record of CONTRIBUTED) await upsertChange(db, record);
  if (CONTRIBUTED.length) console.log(`[worker] ${CONTRIBUTED.length} contributed catalog record(s) merged`);
  const booted = new Date();
  await boss.start();
  await ensureQueues(boss);
  // A deploy kills the previous container mid-job; its jobs stay "active" until they expire (two
  // hours for fix runs), and key_strict_fifo holds the repository's whole queue behind them. This is
  // the only worker, so once the old container is surely gone (Coolify's rolling replace overlaps
  // them briefly), jobs that went active before this one booted are failed and retry here.
  setTimeout(() => {
    void (async () => {
      // A fix job whose run another worker is still heartbeating is that worker's (review R13):
      // during a rolling deploy the old container may still be finishing it.
      const { rows } = await db.execute<{ id: string; name: string }>(sql`
        select j.id, j.name from pgboss.job j
        where j.state = 'active' and j.started_on < ${booted.toISOString()}
          and not exists (
            select 1 from runs r
            where j.name = 'fix' and r.id::text = j.data->>'runId' and r.status = 'running'
              and r.heartbeat_at > now() - make_interval(secs => ${RUNS.leaseMs / 1000})
          )
      `);
      for (const name of new Set(rows.map((r) => r.name)))
        await boss.fail(
          name,
          rows.filter((r) => r.name === name).map((r) => r.id),
          { reason: "the worker restarted during this job" },
        );
      if (rows.length) console.log(`[worker] failed ${rows.length} job(s) a previous container left active`);
    })().catch((error) => console.error(`[worker] stale jobs: ${error}`));
  }, STALE_JOB_SWEEP_MS);
  const unblock = setInterval(() => {
    void (async () => {
      const { rows } = await db.execute<{ id: string; name: string }>(sql`
        select id, name from pgboss.job
        where name in ('fix', 'scan') and state = 'failed' and created_on > now() - interval '2 days'
      `);
      for (const name of new Set(rows.map((r) => r.name)))
        await boss.retry(
          name,
          rows.filter((r) => r.name === name).map((r) => r.id),
        );
      if (rows.length)
        console.log(`[worker] sent ${rows.length} failed job(s) back so their repositories' queues move`);
    })().catch((error) => console.error(`[worker] unblock: ${error}`));
  }, UNBLOCK_MS);
  unblock.unref();

  // GitHub App: scans, fixes and the webhook outbox (S02b). Without the App's credentials the
  // worker only answers its health checks.
  let stopOutbox: (() => Promise<void>) | null = null;
  // Heartbeat, reaper, credit re-check and webhook redeliveries (S10).
  let stopTicker: (() => void) | null = null;
  try {
    const gh = createGitHubApp(githubAppConfigFromEnv());
    const webUrl = process.env.TEIRE_WEB_URL?.replace(/\/$/, "") ?? null;
    const ctx = {
      db,
      gh,
      webUrl,
      enqueueFix: async (runId: string, repoId: number, startAfterSeconds?: number) => {
        await boss.send(
          QUEUES.fix,
          { runId },
          { singletonKey: String(repoId), ...(startAfterSeconds ? { startAfter: startAfterSeconds } : {}) },
        );
      },
      enqueueScan: async (repoId: number, trigger: "install" | "push" | "command" | "manual" | "catalog") => {
        await boss.send(QUEUES.scan, { repoId, trigger }, { singletonKey: String(repoId) });
      },
      enqueuePublicScan: async (publicScanId: string) => {
        await boss.send(QUEUES.public, { publicScanId }, { singletonKey: publicScanId });
      },
    };
    // key_strict_fifo holds a repo's queue behind a failed job, so these handlers never throw:
    // failures live on the scan and run rows.
    await boss.work<{ repoId: number; trigger: "install" | "push" | "command" | "manual" | "catalog" }>(
      QUEUES.scan,
      async (jobs) => {
        for (const job of jobs) {
          try {
            console.log(
              "[scan]",
              job.data.repoId,
              JSON.stringify(await scanRepo(ctx, job.data.repoId, job.data.trigger)),
            );
          } catch (error) {
            if (error instanceof CreditsExhaustedError) await markCreditsExhausted(db, error.message);
            console.error("[scan] failed", job.data.repoId, error);
          }
        }
      },
    );
    await boss.work<{ runId: string }>(
      QUEUES.fix,
      { localConcurrency: RUNS.fixConcurrency },
      async (jobs) => {
        for (const job of jobs) {
          try {
            // A re-verify (U2) shares the fix queue: one job per repository at a time, and the reaper
            // and boot sweep bring it back the same way.
            const kind = (await getRun(db, job.data.runId))?.kind;
            const result =
              kind === "reverify"
                ? await reverifyRun(ctx, job.data.runId)
                : await fixRun(ctx, job.data.runId);
            console.log(kind === "reverify" ? "[reverify]" : "[fix]", job.data.runId, JSON.stringify(result));
          } catch (error) {
            console.error("[fix] failed", job.data.runId, error);
          }
        }
      },
    );
    await boss.work<{ publicScanId: string }>(QUEUES.public, async (jobs) => {
      for (const job of jobs) {
        try {
          console.log(
            "[public]",
            job.data.publicScanId,
            JSON.stringify(await publicScan(ctx, job.data.publicScanId)),
          );
        } catch (error) {
          if (error instanceof CreditsExhaustedError) await markCreditsExhausted(db, error.message);
          console.error("[public] failed", job.data.publicScanId, error);
        }
      }
    });
    stopOutbox = startOutbox({ db, pool, handle: (delivery) => handleDelivery(ctx, delivery) });
    stopTicker = startTicker(db, gh, process.env.SOURCE_COMMIT ?? "dev", (repoId) =>
      ctx.enqueueScan(repoId, "manual"),
    );
    console.log(`[worker] GitHub App ${gh.slug} ready`);
    // Every installation against GitHub's own list of its repositories, at start and every half hour:
    // a webhook that never came (GitHub sends none for a fork in an all-repositories installation), or
    // a reinstall that found its repositories marked removed, is put right.
    const reconcileAll = async () => {
      const live = await db.execute<{ id: number }>(
        sql`select id from installations where deleted_at is null and suspended_at is null`,
      );
      for (const { id } of live.rows) {
        const result = await reconcileInstallation(ctx, Number(id)).catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
        console.log("[reconcile]", id, JSON.stringify(result));
      }
    };
    void reconcileAll();
    const reconcileTimer = setInterval(() => void reconcileAll().catch(() => undefined), RUNS.reconcileMs);
    shutdownHooks.push(async () => clearInterval(reconcileTimer));
  } catch (error) {
    console.warn("[worker] GitHub App not configured:", error instanceof Error ? error.message : error);
  }
  shutdownHooks.push(async () => {
    stopTicker?.();
    await stopOutbox?.();
  });

  server.listen(PORT, () => console.log(`[worker] listening on :${PORT}`));
}

const shutdownHooks: (() => Promise<void>)[] = [];

async function shutdown(signal: string) {
  console.log(`[worker] ${signal}: stopping`);
  server.close();
  for (const hook of shutdownHooks) await hook().catch(() => undefined);
  await boss.stop({ graceful: true, timeout: 30_000 });
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((error) => {
  console.error("[worker] failed to start", error);
  process.exit(1);
});
