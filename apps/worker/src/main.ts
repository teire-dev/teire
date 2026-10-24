import { createServer } from "node:http";
import { resolve } from "node:path";
import { createDb, runMigrations, sql, tlsOptions } from "@teire/db";
import { createGitHubApp, githubAppConfigFromEnv } from "@teire/engine/github";
import { PgBoss } from "pg-boss";
import { handleDelivery } from "./jobs/events";
import { fixRun } from "./jobs/fix";
import { catalogIsEmpty, ingestAll } from "./jobs/ingest";
import { scanRepo } from "./jobs/scan";
import { startOutbox } from "./outbox";
import { ensureQueues, QUEUES, SCHEDULES } from "./queues";
import { revalidateWeb } from "./web";

const PORT = Number(process.env.PORT ?? 8080);
const databaseUrl = process.env.DATABASE_URL;
const caCert = process.env.DATABASE_CA_CERT;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");
if (!caCert) throw new Error("DATABASE_CA_CERT is not set");

const { db, pool } = createDb({ connectionString: databaseUrl, caCert });
const boss = new PgBoss({ connectionString: databaseUrl, ssl: tlsOptions(caCert), schema: "pgboss" });
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
const migrationsDir = process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), "../../packages/db/drizzle");

async function main() {
  await runMigrations(db, migrationsDir);
  console.log("[worker] migrations applied");
  await boss.start();
  await ensureQueues(boss);

  await boss.work(QUEUES.ingest, async () => {
    const summaries = await ingestAll(db);
    for (const s of summaries) console.log("[ingest]", JSON.stringify(s));
    if (summaries.some((s) => s.written > 0)) await revalidateWeb(["catalog"]);
    return summaries;
  });
  await boss.schedule(QUEUES.ingest, SCHEDULES.ingest);
  if (await catalogIsEmpty(db)) await boss.send(QUEUES.ingest, {});

  // GitHub App: scans, fixes and the webhook outbox (S02b). Without the App's credentials the
  // worker still serves the catalog.
  let stopOutbox: (() => Promise<void>) | null = null;
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
      enqueueScan: async (repoId: number, trigger: "install" | "push" | "command" | "manual") => {
        await boss.send(QUEUES.scan, { repoId, trigger }, { singletonKey: String(repoId) });
      },
    };
    // key_strict_fifo holds a repo's queue behind a failed job, so these handlers never throw:
    // failures live on the scan and run rows.
    await boss.work<{ repoId: number; trigger: "install" | "push" | "command" | "manual" }>(
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
            console.error("[scan] failed", job.data.repoId, error);
          }
        }
      },
    );
    await boss.work<{ runId: string }>(QUEUES.fix, async (jobs) => {
      for (const job of jobs) {
        try {
          console.log("[fix]", job.data.runId, JSON.stringify(await fixRun(ctx, job.data.runId)));
        } catch (error) {
          console.error("[fix] failed", job.data.runId, error);
        }
      }
    });
    stopOutbox = startOutbox({ db, pool, handle: (delivery) => handleDelivery(ctx, delivery) });
    console.log(`[worker] GitHub App ${gh.slug} ready`);
  } catch (error) {
    console.warn("[worker] GitHub App not configured:", error instanceof Error ? error.message : error);
  }
  shutdownHooks.push(async () => {
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
