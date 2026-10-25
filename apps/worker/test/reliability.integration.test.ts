import { resolve } from "node:path";
import { createLocalDb, eq, llmCalls, runMigrations, runs, scans } from "@teire/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getState, markCreditsExhausted, modelWorkBlocked, reap, setState } from "../src/reliability";

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

  it("blocks model work at the daily cap, with the reason", async () => {
    process.env.TEIRE_DAILY_COST_CAP_USD = "1";
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
});
