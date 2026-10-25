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
import type { FindingDraft } from "@teire/engine/impact";
import { directoryTree, fetchRepoTarball } from "@teire/engine/inventory";
import {
  type AssessedProject,
  type Assessment,
  assessApiChanges,
  assessGoRepo,
  assessJsRepo,
  assessPyRepo,
  assessRuntimes,
  assessRustRepo,
  runtimesOf,
} from "@teire/engine/pipeline";
import { versionScheme } from "@teire/engine/registry";
import { cargoSurfaceDiff, goSurfaceDiff } from "@teire/engine/surface";
import { cachedSurfaceDiff, postgresRegistryCache } from "../caches";
import {
  changeHash,
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
import { revalidateWeb } from "../web";
import { pageReader, storedProviderChanges } from "./providers";

export interface WorkerContext {
  db: Database;
  gh: GitHubApp;
  /** Enqueues a fix run on the per-repo FIFO queue. */
  enqueueFix: (runId: string, repoId: number, startAfterSeconds?: number) => Promise<void>;
  webUrl: string | null;
}

export const ONBOARDING_BRANCH = "teire/onboarding";

/** Upgrades that may open a PR under the repo's config, best first (D70 priority queue). */
type AnyAssessment = Assessment<AssessedProject>;

export function fixCandidates(assessments: AnyAssessment[], config: TeireConfig) {
  return assessments
    .filter((a) => a.decision?.kind === "upgrade" && a.summary && a.priority !== null)
    .filter((a) => !config.ignore.includes(a.instance.name))
    .filter((a) => (a.decision?.kind === "upgrade" && a.decision.isMajor ? config.upgrades.majors : true))
    .filter((a) => a.summary?.verdict === "affected" || config.upgrades.plainBumps)
    .sort((x, y) => (x.priority ?? 9) - (y.priority ?? 9));
}

/**
 * Provider changes that may open a PR, one entry per group (`models/openai`): affected findings of
 * a PR-opening kind, unless the repo ignores the provider or the model.
 */
export function apiCandidates(findings: FindingDraft[], config: TeireConfig) {
  const groups = new Map<string, FindingDraft[]>();
  for (const f of findings) {
    if (f.verdict !== "affected" || f.priority === null || !f.groupKey) continue;
    const provider = f.groupKey.split("/")[1] ?? "";
    if (
      config.ignore.includes(provider) ||
      (f.position.version && config.ignore.includes(f.position.version))
    )
      continue;
    groups.set(f.groupKey, [...(groups.get(f.groupKey) ?? []), f]);
  }
  return [...groups.entries()].map(([groupKey, list]) => ({
    groupKey,
    findings: list,
    priority: Math.min(...list.map((f) => f.priority ?? 9)),
    from: [...new Set(list.map((f) => f.position.version).filter(Boolean))].join(", "),
    to: [...new Set(list.map((f) => f.position.target).filter(Boolean))].join(", "),
  }));
}

export function groupKeyOf(a: AnyAssessment) {
  return a.decision?.kind === "upgrade"
    ? `${a.instance.ecosystem}/${a.instance.name}/${a.decision.to}`
    : null;
}

function onboardingRows(assessments: AnyAssessment[]): OnboardingRow[] {
  return assessments
    .filter((a) => a.purpose === "upgrade")
    .map((a) => {
      const scheme = versionScheme(a.instance.ecosystem);
      const latest = a.info?.defaultVersion ?? null;
      const behind =
        latest && a.instance.version && scheme.valid(latest) && scheme.valid(a.instance.version)
          ? Math.max(0, scheme.major(latest) - scheme.major(a.instance.version))
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
    const js = await assessJsRepo(checkout.dir, tree, {
      cache,
      cooldownDays: config.upgrades.cooldownDays,
      githubToken: token,
      surfaceDiff: (n, f, t) => cachedSurfaceDiff(db, "npm", n, f, t, { cache }),
    });
    const py = await assessPyRepo(checkout.dir, tree, {
      cache,
      cooldownDays: config.upgrades.cooldownDays,
      githubToken: token,
      surfaceDiff: (n, f, t) => cachedSurfaceDiff(db, "pypi", n, f, t, { cache }),
    });
    const go = await assessGoRepo(checkout.dir, tree, {
      cache,
      cooldownDays: config.upgrades.cooldownDays,
      githubToken: token,
      surfaceDiff: (oldPath, f, newPath, t) =>
        cachedSurfaceDiff(db, "go", oldPath, f, t, { cache }, () => goSurfaceDiff(oldPath, f, newPath, t)),
    });
    const rust = await assessRustRepo(checkout.dir, tree, {
      cache,
      cooldownDays: config.upgrades.cooldownDays,
      githubToken: token,
      surfaceDiff: (n, f, t) =>
        cachedSurfaceDiff(db, "cargo", n, f, t, { cache }, () => cargoSurfaceDiff(n, f, t)),
    });
    const projects: AssessedProject[] = [...js.projects, ...py.projects, ...go.projects, ...rust.projects];
    // Provider changes (S04, D82): only for the API providers this repo talks to, read on demand.
    const api = await assessApiChanges(
      checkout.dir,
      tree,
      projects.flatMap((p) => p.instances),
      {
        changes: storedProviderChanges(db, () => revalidateWeb(["catalog"])),
        discover: { cache },
        triage: await pageReader(db),
        openapi: { cache, githubToken: token, repo: { owner, name, sha } },
        declared: config.sources,
      },
    );
    for (const n of api.openapiNotes) console.log(`[scan] ${repo.fullName}: openapi ${n}`);
    if (api.discovery.candidates)
      console.log(
        `[scan] ${repo.fullName}: ${api.discovery.candidates} provider(s) with no reader; found ${
          api.providers
            .filter((p) => p.provider.discovery)
            .map((p) => p.provider.slug)
            .join(", ") || "none"
        }; Tavily ${api.discovery.usage.reduce((n, u) => n + u.credits, 0)} credit(s)${api.discovery.notes.length ? `; ${api.discovery.notes.join("; ")}` : ""}`,
      );
    // Runtimes the repo runs, against their end of life (notices, never PRs).
    const runtimes = await assessRuntimes(runtimesOf(tree, js.projects, py.projects), { cache });
    // Records computed in this scan (OpenAPI diffs, runtime dates) are stored with their findings;
    // provider records were stored when their pages were read.
    for (const r of [
      ...api.records.filter((x) => x.sources.some((s) => s.kind === "openapi-diff")),
      ...runtimes.records,
    ])
      await upsertChange(db, r);
    const runtimeHashes = new Map(runtimes.records.map((r) => [r.id, changeHash(r)]));
    for (const f of runtimes.findings)
      await upsertFinding(db, repoId, scan.id, f, runtimeHashes.get(f.changeId) ?? "");
    const recordHashes = new Map(api.records.map((r) => [r.id, changeHash(r)]));
    for (const f of api.findings)
      await upsertFinding(db, repoId, scan.id, f, recordHashes.get(f.changeId) ?? "");
    const assessments: AnyAssessment[] = [
      ...js.assessments,
      ...py.assessments,
      ...go.assessments,
      ...rust.assessments,
    ];
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
      languages: [
        ...(js.projects.length ? ["javascript"] : []),
        ...(py.projects.length ? ["python"] : []),
        ...(go.projects.length ? ["go"] : []),
        ...(rust.projects.length ? ["rust"] : []),
      ],
      ...(config.present ? { config, configSource: config.path } : {}),
    });

    let status = repo.status;
    if (status === "detected" && config.present) status = "active";
    if (status === "detected") {
      // Onboarding PR: the inventory, what Teire would do, and the config file whose merge activates it.
      const { title, body } = composeOnboarding({
        repo: { owner, repo: name, baseSha: sha },
        rows: onboardingRows(assessments),
        apiFindings: [...api.findings, ...runtimes.findings],
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

    // Active: enqueue one run per group, best first (D70 queue: provider changes that already broke
    // the repo outrank majors); the fix job applies the PR caps.
    const queue = [
      ...fixCandidates(assessments, config).flatMap((a) => {
        const groupKey = groupKeyOf(a);
        return groupKey && a.decision?.kind === "upgrade"
          ? [{ groupKey, priority: a.priority ?? 9, from: a.instance.version, to: a.decision.to }]
          : [];
      }),
      ...apiCandidates(api.findings, config),
    ].sort((x, y) => x.priority - y.priority);
    let enqueued = 0;
    for (const c of queue) {
      // One PR per group, and nothing a person closed comes back (C6).
      if (await getArtifact(db, repoId, "pr", c.groupKey)) continue;
      const { run, created } = await claimRun(db, {
        repoId,
        groupKey: c.groupKey,
        kind: "fix",
        status: "queued",
        fromVersion: c.from,
        targetVersion: c.to,
        baseSha: sha,
        idempotencyKey: `fix:${repoId}:${c.groupKey}:${sha}`,
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
