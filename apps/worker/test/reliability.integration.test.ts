import { resolve } from "node:path";
import {
  createLocalDb,
  eq,
  inArray,
  llmCalls,
  repos,
  runEvents,
  runMigrations,
  runs,
  scans,
} from "@teire/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dueScheduledScans,
  getState,
  markCreditsExhausted,
  modelWorkBlocked,
  reap,
  setState,
} from "../src/reliability";
import { appendEvent } from "../src/store";

/**
 * S10 done-when, against a real Postgres with Teire's migrations (TEIRE_TEST_DATABASE_URL, e.g. a
 * throwaway `postgres:17` container): a run whose worker died is failed cleanly and can restart;
 * the cost cap and a Token Factory 402 stop model work with a reason a person can read.
 */
const url = process.env.TEIRE_TEST_DATABASE_URL;
const local = url ? createLocalDb(url) : null;
const pool = local?.pool ?? null;
const db = local?.db as NonNullable<typeof local>["db"];

describe.skipIf(!url)("reliability (Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(db, resolve(__dirname, "../../../packages/db/drizzle"));
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("fails a run without a heartbeat as interrupted, and leaves a live one alone", async () => {
    const old = new Date(Date.now() - 20 * 60_000);
    const [dead] = await db
      .insert(runs)
      .values({
        repoId: 1,
        kind: "fix",
        status: "running",
        groupKey: "npm/x/2.0.0",
        idempotencyKey: `dead-${Date.now()}`,
        heartbeatAt: old,
        startedAt: old,
      })
      .returning();
    const [live] = await db
      .insert(runs)
      .values({
        repoId: 1,
        kind: "fix",
        status: "running",
        groupKey: "npm/y/2.0.0",
        idempotencyKey: `live-${Date.now()}`,
        heartbeatAt: new Date(),
      })
      .returning();
    const [stuck] = await db
      .insert(scans)
      .values({
        repoId: 1,
        trigger: "push",
        status: "running",
        startedAt: new Date(Date.now() - 60 * 60_000),
      })
      .returning();
    const reaped = await reap(db);
    expect(reaped.runs).toBeGreaterThanOrEqual(1);
    const [after] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, dead?.id as string));
    expect(after).toMatchObject({ status: "failed", step: "interrupted" });
    expect(after?.error).toContain("worker stopped");
    const [still] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, live?.id as string));
    expect(still?.status).toBe("running");
    const [scan] = await db
      .select()
      .from(scans)
      .where(eq(scans.id, stuck?.id as string));
    expect(scan?.status).toBe("failed");
  });

  it("numbers a run's events in order when both sandboxes report at once", async () => {
    const [run] = await db
      .insert(runs)
      .values({
        repoId: 1,
        kind: "fix",
        status: "running",
        groupKey: "npm/z/2.0.0",
        idempotencyKey: `events-${Date.now()}`,
      })
      .returning();
    if (!run) throw new Error("insert failed");
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        appendEvent(db, run.id, i % 2 ? "after" : "baseline", "exec", { i }),
      ),
    );
    const rows = await db.select({ seq: runEvents.seq }).from(runEvents).where(eq(runEvents.runId, run.id));
    expect(rows.map((r) => r.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it("blocks model work at the daily cap, with the reason", async () => {
    process.env.TEIRE_DAILY_COST_CAP_USD = "1";
    // The throwaway test database keeps rows between runs; this test counts spend from nothing.
    await db.delete(llmCalls);
    expect(await modelWorkBlocked(db)).toBeNull();
    await db
      .insert(llmCalls)
      .values({ purpose: "agent", model: "nvidia/Nemotron-3-Ultra-550b-a55b", costUsd: "1.25" });
    expect(await modelWorkBlocked(db)).toMatch(/daily model budget \(\$1\.00\) is used up \(\$1\.25/);
    delete process.env.TEIRE_DAILY_COST_CAP_USD;
  });

  it("blocks model work after a 402 until it is cleared", async () => {
    process.env.TEIRE_DAILY_COST_CAP_USD = "0";
    await markCreditsExhausted(db, "credit_balance_exhausted");
    expect(await modelWorkBlocked(db)).toMatch(/Token Factory credits are exhausted/);
    const credits = await getState<{ exhausted: boolean }>(db, "credits");
    await setState(db, "credits", { ...credits, exhausted: false });
    expect(await modelWorkBlocked(db)).toBeNull();
    delete process.env.TEIRE_DAILY_COST_CAP_USD;
  });

  it("rescans active repos on their teire.yml schedule, and only those", async () => {
    const day = 24 * 3600_000;
    const base = 9_000_000 + (Date.now() % 100_000);
    const rows = [
      { id: base + 1, schedule: "daily", last: Date.now() - 2 * day, status: "active" },
      { id: base + 2, schedule: "daily", last: Date.now() - 3600_000, status: "active" },
      { id: base + 3, schedule: "weekly", last: Date.now() - 3 * day, status: "active" },
      { id: base + 4, schedule: "weekly", last: Date.now() - 8 * day, status: "active" },
      { id: base + 5, schedule: "push", last: Date.now() - 30 * day, status: "active" },
      { id: base + 6, schedule: "daily", last: Date.now() - 2 * day, status: "paused" },
    ];
    await db.insert(repos).values(
      rows.map((r) => ({
        id: r.id,
        fullName: `test/schedule-${r.id}`,
        defaultBranch: "main",
        status: r.status as "active" | "paused",
        config: { schedule: r.schedule },
        lastScannedAt: new Date(r.last),
      })),
    );
    const due = (await dueScheduledScans(db)).filter((id) => id > base && id <= base + 6).sort();
    expect(due).toEqual([base + 1, base + 4]);
    await db.delete(repos).where(
      inArray(
        repos.id,
        rows.map((r) => r.id),
      ),
    );
  });
});
