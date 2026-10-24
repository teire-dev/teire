import { createServer } from "node:http";
import { createDb, sql } from "@teire/db";
import { PgBoss } from "pg-boss";
import { ensureQueues } from "./queues";

const PORT = Number(process.env.PORT ?? 8080);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const { db, pool } = createDb({ connectionString: databaseUrl, caCert: process.env.DATABASE_CA_CERT });
const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
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

async function main() {
  await boss.start();
  await ensureQueues(boss);
  server.listen(PORT, () => console.log(`[worker] listening on :${PORT}`));
}

async function shutdown(signal: string) {
  console.log(`[worker] ${signal}: stopping`);
  server.close();
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
