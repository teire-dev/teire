import type { PgBoss } from "pg-boss";

/**
 * Four queues (plan D27/architecture review):
 * - event: GitHub webhook deliveries claimed from the outbox
 * - ingest: provider source refresh (scheduled)
 * - scan / fix: one job at a time per repo (key_strict_fifo keyed by repo id)
 */
export const QUEUES = {
  event: "event",
  ingest: "ingest",
  scan: "scan",
  fix: "fix",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Cron schedules (UTC). Provider pages are re-read every 3 hours (CATALOG.checkEveryMs). */
export const SCHEDULES = {
  ingest: "17 */3 * * *",
} as const;

export async function ensureQueues(boss: PgBoss) {
  await boss.createQueue(QUEUES.event, {
    policy: "standard",
    retryLimit: 5,
    retryDelay: 10,
    retryBackoff: true,
  });
  await boss.createQueue(QUEUES.ingest, { policy: "singleton", retryLimit: 2, retryDelay: 60 });
  await boss.createQueue(QUEUES.scan, { policy: "key_strict_fifo", retryLimit: 2, retryDelay: 30 });
  await boss.createQueue(QUEUES.fix, { policy: "key_strict_fifo", retryLimit: 1, retryDelay: 60 });
}

/** Webhook outbox loop (outbox.ts). */
export const OUTBOX = {
  pollMs: 5_000,
  batch: 10,
  /** A claim older than this is taken again (the worker died mid-delivery). */
  reclaimAfterSeconds: 300,
  maxAttempts: 5,
} as const;
