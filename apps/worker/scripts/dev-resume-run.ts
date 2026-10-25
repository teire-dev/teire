/**
 * Development: resume one fix or dry run on the local database (after an interrupted dev run).
 * Run: pnpm --filter @teire/worker exec tsx --env-file=../../.env.local scripts/dev-resume-run.ts <runId>
 */
import { createLocalDb, eq, runs } from "@teire/db";
import { fixRun } from "../src/jobs/fix";
import type { WorkerContext } from "../src/jobs/scan";

const url = process.env.TEIRE_DEV_DATABASE_URL ?? "postgres://postgres:teire@127.0.0.1:55491/teire";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url))
  throw new Error("dev-resume-run runs against a local database only");
const [runId] = process.argv.slice(2);
if (!runId) throw new Error("usage: dev-resume-run.ts <runId>");
const { db, pool } = createLocalDb(url);
// An interrupted run is marked as the reaper would, so fixRun starts it over cleanly.
await db.update(runs).set({ status: "failed", step: "interrupted" }).where(eq(runs.id, runId));
const ctx = {
  db,
  gh: null,
  webUrl: "http://localhost:3101",
  enqueueFix: async () => undefined,
} as unknown as WorkerContext;
console.log(JSON.stringify(await fixRun(ctx, runId)));
await pool.end();
