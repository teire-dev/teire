import { randomUUID } from "node:crypto";
import { actions, and, eq, repos, sql, userInstallations, webhookDeliveries } from "@teire/db";
import { INSTALLATION_ACTIONS } from "@teire/engine/actions";
import { parseAction } from "@teire/engine/actions-schema";
import { database } from "./db";

/**
 * A person's action (plan revision 3.3, "Actions with real results", D121): the `actions` row and its
 * outbox delivery are written in one transaction, so an action is never recorded without reaching
 * the worker, or sent without a record. The worker re-authorizes against GitHub and moves the row to
 * its outcome; the page reads it back through `/api/actions/[id]`.
 */
export type ActionView = typeof actions.$inferSelect;

export async function requestAction(input: {
  userId: string;
  kind: string;
  params: unknown;
  /** One repository (`owner/name`), or an installation for installation-wide actions. */
  repo?: string;
  installationId?: number;
  /** The same key from the same person returns the same action (a double click, a retry). */
  idempotencyKey: string;
  source?: "web" | "assistant";
}): Promise<{ ok: true; action: ActionView } | { ok: false; error: string }> {
  const parsed = parseAction(input.kind, input.params);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!/^[\w:.-]{8,120}$/.test(input.idempotencyKey)) return { ok: false, error: "bad request" };
  const db = database();

  // The scope: a repository or an installation this person's GitHub account can see.
  let repoId: number | null = null;
  let installationId: number | null = null;
  if (INSTALLATION_ACTIONS.has(parsed.kind)) {
    if (!input.installationId) return { ok: false, error: "no installation" };
    const [seen] = await db
      .select({ id: userInstallations.installationId })
      .from(userInstallations)
      .where(
        and(
          eq(userInstallations.userId, input.userId),
          eq(userInstallations.installationId, input.installationId),
        ),
      )
      .limit(1);
    if (!seen) return { ok: false, error: "You can't see that installation" };
    installationId = seen.id;
  } else {
    if (!input.repo || !/^[\w.-]+\/[\w.-]+$/.test(input.repo)) return { ok: false, error: "no repository" };
    const [row] = await db
      .select({ id: repos.id, installationId: repos.installationId })
      .from(repos)
      .innerJoin(
        userInstallations,
        and(
          eq(userInstallations.installationId, repos.installationId),
          eq(userInstallations.userId, input.userId),
        ),
      )
      .where(eq(repos.fullName, input.repo))
      .limit(1);
    if (!row?.installationId) return { ok: false, error: `You can't see ${input.repo}` };
    repoId = row.id;
    installationId = row.installationId;
  }

  const guid = `teire-action-${randomUUID()}`;
  const action = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(actions)
      .values({
        requester: input.userId,
        installationId,
        repoId,
        kind: parsed.kind,
        params: parsed.params,
        source: input.source ?? "web",
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing({ target: [actions.requester, actions.idempotencyKey] })
      .returning();
    if (!created) return null;
    await tx.insert(webhookDeliveries).values({
      guid,
      event: "teire.action",
      action: null,
      installationId,
      payload: { actionId: created.id },
    });
    return created;
  });
  if (!action) {
    // Asked before with this key: the same action, as it stands now.
    const [same] = await db
      .select()
      .from(actions)
      .where(and(eq(actions.requester, input.userId), eq(actions.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    return same ? { ok: true, action: same } : { ok: false, error: "bad request" };
  }
  await db.execute(sql`select pg_notify('teire_webhooks', ${guid})`);
  return { ok: true, action };
}

/**
 * An action for the person asking: their own, or one on an installation they can see now (the
 * Activity of a repository they share). Anyone else gets nothing, as if it didn't exist.
 */
export async function readAction(userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const db = database();
  const [row] = await db.select().from(actions).where(eq(actions.id, id)).limit(1);
  if (!row) return null;
  if (row.requester === userId) return row;
  if (!row.installationId) return null;
  const [seen] = await db
    .select({ id: userInstallations.installationId })
    .from(userInstallations)
    .where(
      and(eq(userInstallations.userId, userId), eq(userInstallations.installationId, row.installationId)),
    )
    .limit(1);
  return seen ? row : null;
}
