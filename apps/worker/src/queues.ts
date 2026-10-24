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
