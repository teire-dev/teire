"use server";

import { randomUUID } from "node:crypto";
import { publicScans, sql, webhookDeliveries } from "@teire/db";
import { PUBLIC_LIMITS } from "@teire/engine/constants";
import { redirect } from "next/navigation";
import { database } from "@/lib/db";
import { usageToday } from "@/lib/reports";
import { getSession } from "@/lib/session";

/**
 * Public scans and dry runs (C9). The web records the request and hands it to the worker through
 * the webhook outbox (D27), as a `teire.*` event; the worker reads GitHub as the person who asked.
 */
export type ScanState = { error: string | null; input?: string };

const GITHUB_REPO =
  /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?(?:[#?].*)?$/;

export async function parseRepo(input: string) {
  const m = GITHUB_REPO.exec(input.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

async function enqueue(guid: string, event: string, payload: Record<string, unknown>) {
  const db = database();
  await db.insert(webhookDeliveries).values({ guid, event, action: null, installationId: null, payload });
  await db.execute(sql`select pg_notify('teire_webhooks', ${guid})`);
}

export async function startPublicScan(_prev: ScanState, form: FormData): Promise<ScanState> {
  const input = String(form.get("repo") ?? "");
  const session = await getSession();
  if (!session) return { error: "Sign in with GitHub to start a scan.", input };
  const repo = await parseRepo(input);
  if (!repo) return { error: "Enter a GitHub repository as owner/name, or paste its URL.", input };
  const used = await usageToday(session.user.id);
  if (used.scans >= PUBLIC_LIMITS.scansPerUserPerDay)
    return {
      error: `You have used today's ${PUBLIC_LIMITS.scansPerUserPerDay} public scans. Install Teire to scan your own repositories without a limit.`,
      input,
    };
  const [row] = await database()
    .insert(publicScans)
    .values({ repoFullName: repo, requestedBy: session.user.id })
    .returning({ id: publicScans.id });
  if (!row) return { error: "The scan could not be recorded; try again.", input };
  await enqueue(`teire-public-scan-${row.id}`, "teire.public_scan", { publicScanId: row.id });
  redirect(`/scan/${row.id}`);
}

export async function startDryRun(form: FormData) {
  const publicScanId = String(form.get("publicScanId") ?? "");
  const groupKey = String(form.get("groupKey") ?? "");
  const session = await getSession();
  if (!session) redirect(`/scan/${publicScanId}?signin=1`);
  if (!/^[0-9a-f-]{36}$/.test(publicScanId) || !groupKey) redirect("/scan");
  const runId = randomUUID();
  await enqueue(`teire-dry-run-${runId}`, "teire.dry_run", {
    runId,
    publicScanId,
    groupKey,
    requestedBy: session.user.id,
  });
  redirect(`/runs/${runId}`);
}
