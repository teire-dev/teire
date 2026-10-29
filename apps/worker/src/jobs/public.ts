import { rm } from "node:fs/promises";
import {
  account,
  and,
  type Database,
  eq,
  findings,
  gte,
  publicScans,
  repos,
  runs,
  scans,
  sql,
} from "@teire/db";
import { readTeireConfig } from "@teire/engine/config";
import { PUBLIC_LIMITS } from "@teire/engine/constants";
import { lineageKey } from "@teire/engine/contract";
import { directoryTree, fetchRepoTarball, scopedTree } from "@teire/engine/inventory";
import { advisoryStatus, coverageLines } from "@teire/engine/pipeline";
import { modelWorkBlocked } from "../reliability";
import { claimRun, finishScan, setRepo, startScan } from "../store";
import { revalidateWeb } from "../web";
import { assessCheckout, languagesOf, type WorkerContext } from "./scan";

/**
 * Public scans and dry runs (card C9): any public repository, no installation. A signed-in person
 * asks on the web, which records the request and hands it to the worker through the outbox
 * (`teire.public_scan`, `teire.dry_run`). GitHub is read with that person's own token (their rate
 * limit), anonymously when there is none, and never written to.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The GitHub token Better Auth stored when this person signed in, if any. */
export async function requesterToken(db: Database, userId: string | null | undefined) {
  if (!userId) return undefined;
  const [row] = await db
    .select({ token: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  return row?.token ?? undefined;
}

async function githubGet<T>(path: string, token: string | undefined): Promise<T | null> {
  const get = (auth: string | undefined) =>
    fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  let res = await get(token);
  // An expired or revoked sign-in token: public data is still readable anonymously.
  if (res.status === 401 && token) res = await get(undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface RepoMeta {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  size: number;
}

export async function publicScan(ctx: WorkerContext, publicScanId: string) {
  const { db } = ctx;
  if (!UUID.test(publicScanId)) return { skipped: "bad id" };
  const [request] = await db.select().from(publicScans).where(eq(publicScans.id, publicScanId)).limit(1);
  if (!request || request.status === "done") return { skipped: true };
  const settle = (status: "done" | "failed", error: string | null = null) =>
    db
      .update(publicScans)
      .set({ status, error, finishedAt: new Date() })
      .where(eq(publicScans.id, publicScanId));
  await db
    .update(publicScans)
    .set({ status: "running", step: "repo", error: null })
    .where(eq(publicScans.id, publicScanId));

  const token = await requesterToken(db, request.requestedBy);
  const meta = await githubGet<RepoMeta>(`/repos/${request.repoFullName}`, token);
  if (!meta || meta.private) {
    await settle("failed", `${request.repoFullName} is not a public GitHub repository`);
    return { failed: "not public" };
  }
  if (meta.size > PUBLIC_LIMITS.maxRepoKb) {
    await settle(
      "failed",
      `${meta.full_name} is ${Math.round(meta.size / 1024)} MB; public scans take repositories up to ${PUBLIC_LIMITS.maxRepoKb / 1024} MB (install Teire to scan it)`,
    );
    return { failed: "too large" };
  }
  const head = await githubGet<{ sha: string }>(
    `/repos/${meta.full_name}/commits/${encodeURIComponent(meta.default_branch)}`,
    token,
  );
  if (!head) {
    await settle("failed", `${meta.full_name} has no commits on ${meta.default_branch}`);
    return { failed: "empty" };
  }
  // A repo row without an installation; an installed repo keeps its installation and status.
  await db
    .insert(repos)
    .values({ id: meta.id, fullName: meta.full_name, defaultBranch: meta.default_branch, isPrivate: false })
    .onConflictDoUpdate({
      target: repos.id,
      set: { fullName: meta.full_name, defaultBranch: meta.default_branch, isPrivate: false },
    });
  const scan = await startScan(db, meta.id, "public", request.requestedBy);
  await db
    .update(publicScans)
    .set({ repoId: meta.id, scanId: scan.id, repoFullName: meta.full_name })
    .where(eq(publicScans.id, publicScanId));

  const [owner = "", name = ""] = meta.full_name.split("/");
  let dir: string | null = null;
  try {
    const checkout = await fetchRepoTarball(owner, name, head.sha, token ? { token } : {});
    dir = checkout.dir;
    const config = readTeireConfig(directoryTree(dir));
    const tree = scopedTree(directoryTree(dir), config);
    const blocked = await modelWorkBlocked(db);
    const result = await assessCheckout(db, {
      repoId: meta.id,
      scanId: scan.id,
      fullName: meta.full_name,
      dir,
      tree,
      config,
      sha: head.sha,
      ...(token ? { token } : {}),
      blocked,
      // The report's live flow follows the scan (V5–V6 review).
      onStep: (step) => db.update(publicScans).set({ step }).where(eq(publicScans.id, publicScanId)),
    });
    // The whole scan's coverage, as an installed scan stores it: an advisory source that was down
    // shows on the report as "unavailable", never as an empty list (D96).
    const coverage = {
      ...(result.assessments.find((a) => a.located)?.located?.coverage ?? {}),
      advisoryStatus: advisoryStatus(result.coverage),
      gaps: coverageLines(result.coverage),
      detectOnly: result.coverage.detectOnly,
    };
    await finishScan(db, scan.id, { status: "done", sha: head.sha, coverage });
    await setRepo(db, meta.id, {
      lastScannedSha: head.sha,
      lastScannedAt: new Date(),
      languages: languagesOf(result),
    });
    await settle("done");
    // What the scan added to the catalog (package diffs, advisories, deadlines) shows on /changes and
    // the landing's deadline strip now, not after the cache's hour (R-P34, R-M15).
    await revalidateWeb(["catalog"]).catch(() => undefined);
    return { scanned: meta.full_name, findings: result.assessments.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishScan(db, scan.id, { status: "failed", sha: head.sha, error: message });
    await settle("failed", message.slice(0, 500));
    throw error;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/**
 * "Dry-run a fix" on one affected group of a public scan: the fix run of C4 and C5 with every
 * GitHub write left out (fixRun's `dry_run` path). The web chose the run id, so the person is already
 * on its page; a request over the daily limit becomes a failed run that says so.
 */
export async function requestDryRun(
  ctx: WorkerContext,
  payload: { runId?: string; publicScanId?: string; groupKey?: string; requestedBy?: string },
) {
  const { db } = ctx;
  const { runId, publicScanId, groupKey, requestedBy } = payload;
  if (!runId || !UUID.test(runId) || !publicScanId || !UUID.test(publicScanId) || !groupKey || !requestedBy)
    return { skipped: "bad request" };
  // Runtime end of life is a notice, never a fix run.
  if (groupKey.startsWith("runtime/")) return { skipped: "runtime notice" };
  const [request] = await db.select().from(publicScans).where(eq(publicScans.id, publicScanId)).limit(1);
  if (!request?.repoId || !request.scanId || request.status !== "done") return { skipped: "scan not ready" };
  const [scan] = await db.select().from(scans).where(eq(scans.id, request.scanId)).limit(1);
  const group = await db
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.repoId, request.repoId),
        eq(findings.scanId, request.scanId),
        eq(findings.groupKey, groupKey),
        eq(findings.verdict, "affected"),
      ),
    );
  if (!scan?.sha || !group.length) return { skipped: "no affected finding in that group" };
  const positions = group.map((f) => f.position as { version: string | null; target: string | null } | null);
  const join = (values: (string | null | undefined)[]) =>
    [...new Set(values.filter(Boolean))].join(", ") || null;
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runs)
    .where(
      and(
        eq(runs.kind, "dry_run"),
        eq(runs.requestedBy, requestedBy),
        gte(runs.createdAt, new Date(Date.now() - 86_400_000)),
      ),
    );
  const overLimit = count >= PUBLIC_LIMITS.dryRunsPerUserPerDay;
  const { run, created } = await claimRun(db, {
    id: runId,
    repoId: request.repoId,
    groupKey,
    lineageKey: lineageKey(groupKey),
    kind: "dry_run",
    status: overLimit ? "failed" : "queued",
    ...(overLimit
      ? {
          step: "limit",
          error: `${PUBLIC_LIMITS.dryRunsPerUserPerDay} dry run per person per day; install Teire for fixes as pull requests`,
          finishedAt: new Date(),
        }
      : {}),
    fromVersion: join(positions.map((p) => p?.version)),
    // An API group's target is the replacement models; a package group's is its key's last part.
    targetVersion: join(positions.map((p) => p?.target)) ?? groupKey.split("/").pop() ?? null,
    baseSha: scan.sha,
    isPublic: true,
    requestedBy,
    idempotencyKey: `dry:${runId}`,
  });
  if (created && !overLimit) await ctx.enqueueFix(run.id, request.repoId);
  return { run: run.id, queued: created && !overLimit };
}
