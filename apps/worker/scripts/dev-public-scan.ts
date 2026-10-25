/**
 * Development: one public scan (C9) against a local database, through the worker's own job and
 * without the outbox or pg-boss. GITHUB_TOKEN stands in for a signed-in person's GitHub token.
 * Run: pnpm --filter @teire/worker exec tsx --env-file=../../.env.local scripts/dev-public-scan.ts owner/repo
 */
import { account, createLocalDb, publicScans, user } from "@teire/db";
import { publicScan } from "../src/jobs/public";
import type { WorkerContext } from "../src/jobs/scan";

const url = process.env.TEIRE_DEV_DATABASE_URL ?? "postgres://postgres:teire@127.0.0.1:55491/teire";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url))
  throw new Error("dev-public-scan runs against a local database only");
const [repo] = process.argv.slice(2);
if (!repo) throw new Error("usage: dev-public-scan.ts owner/repo");
const { db, pool } = createLocalDb(url);
await db
  .insert(user)
  .values({ id: "dev", name: "Local developer", email: "dev@localhost", emailVerified: true })
  .onConflictDoNothing();
const token = process.env.GITHUB_TOKEN;
if (token)
  await db
    .insert(account)
    .values({ id: "dev-github", accountId: "dev", providerId: "github", userId: "dev", accessToken: token })
    .onConflictDoUpdate({ target: account.id, set: { accessToken: token } });
const [request] = await db.insert(publicScans).values({ repoFullName: repo, requestedBy: "dev" }).returning();
if (!request) throw new Error("insert failed");
const ctx = { db, gh: null, webUrl: null, enqueueFix: async () => undefined } as unknown as WorkerContext;
console.log(JSON.stringify(await publicScan(ctx, request.id)));
console.log(`report: /scan/${request.id}`);
await pool.end();
