import { verify } from "@octokit/webhooks-methods";
import { sql, webhookDeliveries } from "@teire/db";
import { database } from "@/lib/db";

/**
 * GitHub App webhooks (plan: webhooks → outbox). Verify `X-Hub-Signature-256` against the raw body,
 * store the delivery once (GitHub's delivery id is the key, so redeliveries are no-ops), wake the
 * worker with NOTIFY, and answer 202 at once; the worker does the work.
 */
export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "webhook secret not configured" }, { status: 503 });
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!signature || !(await verify(secret, body, signature).catch(() => false)))
    return Response.json({ error: "invalid signature" }, { status: 401 });

  const guid = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");
  if (!guid || !event) return Response.json({ error: "missing delivery headers" }, { status: 400 });
  const payload = JSON.parse(body) as { action?: string; installation?: { id?: number } };

  const db = database();
  await db
    .insert(webhookDeliveries)
    .values({
      guid,
      event,
      action: payload.action ?? null,
      installationId: payload.installation?.id ?? null,
      payload,
    })
    .onConflictDoNothing();
  await db.execute(sql`select pg_notify('teire_webhooks', ${guid})`);
  return new Response(null, { status: 202 });
}
