/**
 * Development: a dry run (C9) on a local public-scan report, through the worker's own request
 * handler and fix job (the real sandbox), without the outbox or pg-boss.
 * Run: pnpm --filter @teire/worker exec tsx --env-file=../../.env.local scripts/dev-dry-run.ts <publicScanId> <groupKey>
 */
import { randomUUID } from "node:crypto";
import { createLocalDb } from "@teire/db";
import { fixRun } from "../src/jobs/fix";
import { requestDryRun } from "../src/jobs/public";
import type { WorkerContext } from "../src/jobs/scan";

const url = process.env.TEIRE_DEV_DATABASE_URL ?? "postgres://postgres:teire@127.0.0.1:55491/teire";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url))
  throw new Error("dev-dry-run runs against a local database only");
const [publicScanId, groupKey] = process.argv.slice(2);
if (!publicScanId || !groupKey) throw new Error("usage: dev-dry-run.ts <publicScanId> <groupKey>");
const { db, pool } = createLocalDb(url);
const ctx = {
  db,
  gh: null,
  webUrl: "http://localhost:3101",
  enqueueFix: async (runId: string) => {
    console.log(JSON.stringify(await fixRun(ctx, runId)));
  },
} as unknown as WorkerContext;
const runId = randomUUID();
console.log(`run: /runs/${runId}`);
console.log(JSON.stringify(await requestDryRun(ctx, { runId, publicScanId, groupKey, requestedBy: "dev" })));
await pool.end();
