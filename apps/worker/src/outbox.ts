import { type createDb, type Database, sql } from "@teire/db";
import { OUTBOX } from "./queues";

/**
 * The webhook outbox (plan D27): the web route stores each verified delivery and sends
 * `NOTIFY teire_webhooks`; this loop LISTENs and also polls every few seconds, claims pending rows
 * with `FOR UPDATE SKIP LOCKED`, and hands each to `handle`. A failing delivery is retried with the
 * attempt count kept; after the cap it is set aside with its error.
 */
type Pool = ReturnType<typeof createDb>["pool"];

export interface Delivery {
  guid: string;
  event: string;
  action: string | null;
  installation_id: number | null;
  payload: Record<string, unknown>;
  attempts: number;
}

export function startOutbox(input: {
  db: Database;
  pool: Pool;
  handle: (delivery: Delivery) => Promise<void>;
}) {
  let running = false;
  let again = false;
  let stopped = false;

  const claim = async () => {
    const result = await input.db.execute(sql`
      update webhook_deliveries set claimed_at = now(), attempts = attempts + 1
      where guid in (
        select guid from webhook_deliveries
        where processed_at is null
          and (claimed_at is null or claimed_at < now() - make_interval(secs => ${OUTBOX.reclaimAfterSeconds}))
        order by received_at
        limit ${OUTBOX.batch}
        for update skip locked
      )
      returning guid, event, action, installation_id, payload, attempts
    `);
    return result.rows as unknown as Delivery[];
  };

  const drain = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const batch = await claim();
        for (const delivery of batch) {
          try {
            await input.handle(delivery);
            await input.db.execute(
              sql`update webhook_deliveries set processed_at = now(), error = null where guid = ${delivery.guid}`,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[outbox]", delivery.event, delivery.guid, message);
            const giveUp = delivery.attempts >= OUTBOX.maxAttempts;
            await input.db.execute(sql`
              update webhook_deliveries
              set error = ${message}, claimed_at = ${giveUp ? sql`claimed_at` : sql`null`},
                  processed_at = ${giveUp ? sql`now()` : sql`null`}
              where guid = ${delivery.guid}
            `);
          }
        }
        if (batch.length === OUTBOX.batch) again = true;
      } while (again && !stopped);
    } finally {
      running = false;
    }
  };

  let listener: { release(destroy?: boolean): void } | null = null;
  const listen = async () => {
    const client = await input.pool.connect();
    listener = client;
    client.on("notification", () => void drain());
    client.on("error", () => {
      client.release(true);
      listener = null;
      if (!stopped) setTimeout(() => void listen().catch(() => undefined), OUTBOX.pollMs);
    });
    await client.query("LISTEN teire_webhooks");
  };
  void listen().catch((error) => console.error("[outbox] LISTEN failed; polling only", error));
  const timer = setInterval(() => void drain().catch((e) => console.error("[outbox]", e)), OUTBOX.pollMs);
  void drain();

  return async () => {
    stopped = true;
    clearInterval(timer);
    listener?.release();
  };
}
