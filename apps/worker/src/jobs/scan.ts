import { rm } from "node:fs/promises";
import type { Database } from "@teire/db";
import { readTeireConfig, type TeireConfig } from "@teire/engine/config";
import {
  commitToBranch,
  composeOnboarding,
  DEFAULT_CONFIG,
  type GitHubApp,
  type OnboardingRow,
  openOrUpdatePullRequest,
} from "@teire/engine/github";
import { directoryTree, fetchRepoTarball } from "@teire/engine/inventory";
import { type Assessment, assessJsRepo } from "@teire/engine/pipeline";
import semver from "semver";
import { cachedNpmSurfaceDiff, postgresRegistryCache } from "../caches";
import {
  claimRun,
  finishScan,
  getArtifact,
  getRepo,
  saveInstances,
  setRepo,
  startScan,
  upsertArtifact,
  upsertChange,
  upsertFinding,
} from "../store";

export interface WorkerContext {
  db: Database;
  gh: GitHubApp;
  /** Enqueues a fix run on the per-repo FIFO queue. */
  enqueueFix: (runId: string, repoId: number, startAfterSeconds?: number) => Promise<void>;
  webUrl: string | null;
}

export const ONBOARDING_BRANCH = "teire/onboarding";

/** Upgrades that may open a PR under the repo's config, best first (D70 priority queue). */
export function fixCandidates(assessments: Assessment[], config: TeireConfig) {
  return assessments
    .filter((a) => a.decision?.kind === "upgrade" && a.summary && a.priority !== null)
    .filter((a) => !config.ignore.includes(a.instance.name))
    .filter((a) => (a.decision?.kind === "upgrade" && a.decision.isMajor ? config.upgrades.majors : true))
    .filter((a) => a.summary?.verdict === "affected" || config.upgrades.plainBumps)
    .sort((x, y) => (x.priority ?? 9) - (y.priority ?? 9));
}

export function groupKeyOf(a: Assessment) {
  return a.decision?.kind === "upgrade" ? `npm/${a.instance.name}/${a.decision.to}` : null;
}

function onboardingRows(assessments: Assessment[]): OnboardingRow[] {
  return assessments.map((a) => {
    const latest = a.info?.defaultVersion ?? null;
    const behind =
      latest && a.instance.version && semver.valid(latest) && semver.valid(a.instance.version)
        ? Math.max(0, semver.major(latest) - semver.major(a.instance.version))
        : 0;
    const c = a.summary?.coverage;
    return {
      instance: a.instance,
      target: a.decision?.kind === "upgrade" ? a.decision.to : null,
      majorsBehind: behind,
      deprecated: a.deprecation ? a.deprecation.summary : null,
      verdict: a.summary?.verdict ?? null,
      breakingSites: (a.summary?.breaking ?? []).reduce((n, f) => n + f.callSites.length, 0),
      coverage: c ? `${c.filesScanned} files, ${c.resolutionLevel}-resolved` : null,
    };
  });
}

export async function scanRepo(
  ctx: WorkerContext,
  repoId: number,
  trigger: "install" | "push" | "command" | "manual",
) {
  const { db, gh } = ctx;
  const repo = await getRepo(db, repoId);
  if (!repo?.installationId) throw new Error(`repo ${repoId} has no installation`);
  if (repo.status === "paused" || repo.status === "disabled") return { skipped: repo.status };
  const [owner = "", name = ""] = repo.fullName.split("/");
  const installation = await gh.installation(repo.installationId);
  const token = await installation.token();
  // Installation payloads carry no default branch; GitHub's own answer decides.
  const { data: meta } = await installation.octokit.rest.repos.get({ owner, repo: name });
  if (meta.default_branch !== repo.defaultBranch || meta.private !== repo.isPrivate) {
    await setRepo(db, repoId, { defaultBranch: meta.default_branch, isPrivate: meta.private });
    repo.defaultBranch = meta.default_branch;
  }
  const { data: branch } = await installation.octokit.rest.repos.getBranch({
    owner,
    repo: name,
    branch: repo.defaultBranch,
  });
  const sha = branch.commit.sha;
  const scan = await startScan(db, repoId, trigger);
  let dir: string | null = null;
  try {
    const checkout = await fetchRepoTarball(owner, name, sha, { token });
    dir = checkout.dir;
    const tree = directoryTree(checkout.dir);
    const config = readTeireConfig(tree);
    const cache = postgresRegistryCache(db);
    const { projects, assessments } = await assessJsRepo(checkout.dir, tree, {
      cache,
      cooldownDays: config.upgrades.cooldownDays,
      githubToken: token,
      surfaceDiff: (n, f, t) => cachedNpmSurfaceDiff(db, n, f, t, { cache }),
    });
    await saveInstances(
      db,
      scan.id,
      repoId,
      projects.flatMap((p) => p.instances),
    );
    for (const a of assessments) {
      const hashes = new Map<string, string>();
      for (const record of [...a.records, ...(a.deprecation ? [a.deprecation] : [])])
        hashes.set(record.id, await upsertChange(db, record));
      for (const f of a.findings) await upsertFinding(db, repoId, scan.id, f, hashes.get(f.changeId) ?? "");
    }
    const coverage = assessments.find((a) => a.located)?.located?.coverage ?? null;
    await finishScan(db, scan.id, { status: "done", sha, coverage });
    await setRepo(db, repoId, {
      lastScannedSha: sha,
      lastScannedAt: new Date(),
      languages: [...new Set(projects.map(() => "javascript"))],
      ...(config.present ? { config, configSource: config.path } : {}),
    });

    let status = repo.status;
    if (status === "detected" && config.present) status = "active";
    if (status === "detected") {
      // Onboarding PR: the inventory, what Teire would do, and the config file whose merge activates it.
      const { title, body } = composeOnboarding({
        repo: { owner, repo: name, baseSha: sha },
        rows: onboardingRows(assessments),
      });
      const commit = await commitToBranch({
        octokit: installation.octokit,
        owner,
        repo: name,
        branch: ONBOARDING_BRANCH,
        baseSha: sha,
        botLogin: gh.botLogin,
        headline: "Add Teire configuration",
        body: "Merging this enables Teire for the repository.",
        files: [{ path: ".github/teire.yml", content: DEFAULT_CONFIG }],
      });
      const pr = await openOrUpdatePullRequest({
        octokit: installation.octokit,
        owner,
        repo: name,
        branch: ONBOARDING_BRANCH,
        base: repo.defaultBranch,
        title,
        body,
        draft: false,
        labels: ["teire"],
      });
      await upsertArtifact(db, {
        repoId,
        kind: "onboarding",
        changeKey: "",
        number: pr.number,
        branch: ONBOARDING_BRANCH,
        headSha: commit.oid,
        state: "open",
        url: pr.url,
      });
      await setRepo(db, repoId, { status: "onboarding" });
      return { onboarding: pr.url };
    }
    if (status !== repo.status) await setRepo(db, repoId, { status });
    if (status !== "active") return { status };

    // Active: enqueue one run per upgrade group, best first; the fix job applies the PR caps.
    let enqueued = 0;
    for (const a of fixCandidates(assessments, config)) {
      const groupKey = groupKeyOf(a);
      if (!groupKey || a.decision?.kind !== "upgrade") continue;
      // One PR per group, and nothing a person closed comes back (C6).
      if (await getArtifact(db, repoId, "pr", groupKey)) continue;
      const { run, created } = await claimRun(db, {
        repoId,
        groupKey,
        kind: "fix",
        status: "queued",
        fromVersion: a.instance.version,
        targetVersion: a.decision.to,
        baseSha: sha,
        idempotencyKey: `fix:${repoId}:${groupKey}:${sha}`,
      });
      if (created) {
        await ctx.enqueueFix(run.id, repoId);
        enqueued++;
      }
    }
    return { status, enqueued };
  } catch (error) {
    await finishScan(db, scan.id, {
      status: "failed",
      sha,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
