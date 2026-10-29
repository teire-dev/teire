import { verify } from "@octokit/webhooks-methods";
import { eq, repos, sql, webhookDeliveries } from "@teire/db";
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
  // Visibility at once, in the request (V7 final review): a repository that turns private leaves the
  // public pages before the worker has even read this delivery; a deleted one too.
  const repoEvent = payload as { action?: string; repository?: { id?: number } };
  if (event === "repository" && repoEvent.repository?.id) {
    const id = repoEvent.repository.id;
    if (repoEvent.action === "privatized" || repoEvent.action === "deleted")
      await db.update(repos).set({ isPrivate: true }).where(eq(repos.id, id));
    else if (repoEvent.action === "publicized")
      await db.update(repos).set({ isPrivate: false }).where(eq(repos.id, id));
  }
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
