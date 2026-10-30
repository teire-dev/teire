import type { PgBoss } from "pg-boss";

/**
 * Three queues (plan D27/architecture review):
 * - event: GitHub webhook deliveries claimed from the outbox
 * - scan / fix: one job at a time per repo (key_strict_fifo keyed by repo id)
 * Provider change sources are read inside scans, for the providers a repo uses (D82).
 */
export const QUEUES = {
  event: "event",
  scan: "scan",
  fix: "fix",
  /** Public scans (C9): any public repo, asked for on the web; failures live on the request row. */
  public: "public",
} as const;

/** Queues and schedules of earlier designs, removed from pg-boss at startup (D82: no scheduled ingest). */
export const RETIRED_QUEUES = ["ingest"] as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export async function ensureQueues(boss: PgBoss) {
  await boss.createQueue(QUEUES.event, {
    policy: "standard",
    retryLimit: 5,
    retryDelay: 10,
    retryBackoff: true,
  });
  await boss.createQueue(QUEUES.scan, { policy: "key_strict_fifo", retryLimit: 2, retryDelay: 30 });
  await boss.createQueue(QUEUES.fix, { policy: "key_strict_fifo", retryLimit: 1, retryDelay: 60 });
  await boss.createQueue(QUEUES.public, { policy: "standard", retryLimit: 0 });
  // pg-boss expires an active job after 15 minutes by default; a fix run with four attempts can
  // take longer. The reliability ticker reaps stuck work first (runs and scans 10 min without a
  // heartbeat), so these bounds only stop pg-boss retrying work that is still running; a scan's
  // sandbox probes end by 50 min.
  // updateQueue also applies them to queues created before this setting existed.
  for (const [name, expireInSeconds] of [
    [QUEUES.scan, 3600],
    [QUEUES.public, 3600],
    [QUEUES.fix, 7200],
  ] as const)
    await boss.updateQueue(name, { expireInSeconds });
  for (const name of RETIRED_QUEUES) {
    await boss.unschedule(name).catch(() => undefined);
    await boss.deleteQueue(name).catch(() => undefined);
  }
}

/** Webhook outbox loop (outbox.ts). */
export const OUTBOX = {
  pollMs: 5_000,
  batch: 10,
  /** A claim older than this is taken again (the worker died mid-delivery). */
  reclaimAfterSeconds: 300,
  maxAttempts: 5,
} as const;
