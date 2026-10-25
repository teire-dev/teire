"use server";

import { randomUUID } from "node:crypto";
import { sql, webhookDeliveries } from "@teire/db";
import { redirect } from "next/navigation";
import { repoDetail } from "@/lib/dashboard";
import { database } from "@/lib/db";
import { getSession } from "@/lib/session";

const ACTIONS = new Set(["rescan", "pause", "resume", "fix", "ignore", "unignore"]);

/**
 * A button on a repo page (S11): the matching `@teire` command, through the outbox as
 * `teire.repo_action`. The worker checks access again before it acts.
 */
export async function repoAction(form: FormData) {
  const session = await getSession();
  const repo = String(form.get("repo") ?? "");
  const action = String(form.get("action") ?? "");
  const target = String(form.get("target") ?? "");
  const back = String(form.get("back") ?? `/app/repos/${repo}`);
  if (!session) redirect("/app");
  if (!ACTIONS.has(action) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) redirect(back);
  const detail = await repoDetail(session.user.id, repo);
  if (!detail) redirect("/app/repos");
  const guid = `teire-repo-action-${randomUUID()}`;
  const db = database();
  await db.insert(webhookDeliveries).values({
    guid,
    event: "teire.repo_action",
    action: null,
    installationId: detail.repo.installationId,
    payload: { repoId: detail.repo.id, action, target, userId: session.user.id },
  });
  await db.execute(sql`select pg_notify('teire_webhooks', ${guid})`);
  redirect(`${back}${back.includes("?") ? "&" : "?"}queued=${action}`);
}
