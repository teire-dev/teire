import { rm } from "node:fs/promises";
import { type Database, sql } from "@teire/db";
import { osvAdvisoryIds } from "@teire/engine/advisories";
import { readTeireConfig, type TeireConfig } from "@teire/engine/config";
import { ECOSYSTEMS, lineageKey } from "@teire/engine/contract";
import {
  commitToBranch,
  composeOnboarding,
  DEFAULT_CONFIG,
  type GitHubApp,
  type OnboardingRow,
  openOrUpdatePullRequest,
  publishConfigCheckRun,
} from "@teire/engine/github";
import type { FindingDraft } from "@teire/engine/impact";
import {
  directoryTree,
  fetchRepoTarball,
  type OtherPackage,
  osvExtract,
  scopedTree,
} from "@teire/engine/inventory";
import {
  type AssessedProject,
  type Assessment,
  advisoryStatus,
  assessApiChanges,
  assessGoRepo,
  assessJsRepo,
  assessJvmRepo,
  assessPyRepo,
  assessRubyRepo,
  assessRuntimes,
  assessRustRepo,
  coverageLines,
  lookupsAnswered,
  newScanCoverage,
  runtimesOf,
  type ScanCoverage,
} from "@teire/engine/pipeline";
import { versionScheme } from "@teire/engine/registry";
import { cargoSurfaceDiff, goSurfaceDiff } from "@teire/engine/surface";
import { selectBackend } from "@teire/engine/verify";
import { cachedSurfaceDiff, postgresRegistryCache } from "../caches";
import { modelWorkBlocked } from "../reliability";
import {
  changeHash,
  claimRun,
  finishScan,
  getArtifact,
  getRepo,
  openArtifacts,
  openLineages,
  recordLlmCall,
  retireUnreported,
  saveInstances,
  setFindingsState,
  setRepo,
  setRepoProviders,
  startScan,
  upsertArtifact,
  upsertChange,
  upsertFinding,
} from "../store";
import { revalidateWeb } from "../web";
import { matchesTarget, readOrgConfig } from "./commands";
import { syncDashboard, syncHumanIssues } from "./dashboard";
import { pageReader, storedProviderChanges } from "./providers";

export interface WorkerContext {
  db: Database;
  gh: GitHubApp;
  /** Enqueues a fix run on the per-repo FIFO queue. */
  enqueueFix: (runId: string, repoId: number, startAfterSeconds?: number) => Promise<void>;
  /** Enqueues a scan (provider fan-out, D95); absent in contexts that never scan other repos. */
  enqueueScan?: (
    repoId: number,
    trigger: "install" | "push" | "command" | "manual" | "catalog",
  ) => Promise<void>;
  webUrl: string | null;
}

/** What the scan looks for, said when it finds none of it (card C1). */
const SEARCHED = [
  "package.json + a lockfile",
  "pyproject.toml, requirements*.txt, Pipfile, setup.py",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "pom.xml, build.gradle(.kts)",
  "API URLs and model IDs in source files",
];

export const ONBOARDING_BRANCH = "teire/onboarding";

/** Upgrades that may open a PR under the repo's config, best first (D70 priority queue). */
type AnyAssessment = Assessment<AssessedProject>;

export function fixCandidates(assessments: AnyAssessment[], config: TeireConfig) {
  return assessments
    .filter((a) => a.decision?.kind === "upgrade" && a.summary && a.priority !== null)
    .filter(
      (a) =>
        !config.ignore.includes(a.instance.name) &&
        !config.ignore.includes(`${a.instance.ecosystem}:${a.instance.name}`),
    )
    .filter((a) => !config.upgrades.allow.length || config.upgrades.allow.includes(a.instance.name))
    .filter((a) => !config.upgrades.deny.includes(a.instance.name))
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

/** The ecosystems a scan found projects in, as stored on the repo. */
export function languagesOf(
  groups: Record<"js" | "py" | "go" | "rust" | "ruby" | "jvm", { projects: unknown[] }>,
) {
  const names = { js: "javascript", py: "python", go: "go", rust: "rust", ruby: "ruby", jvm: "jvm" } as const;
  return (Object.keys(names) as (keyof typeof names)[])
    .filter((k) => groups[k].projects.length)
    .map((k) => names[k]);
}

export function groupKeyOf(a: AnyAssessment) {
  return a.decision?.kind === "upgrade"
    ? `${a.instance.ecosystem}/${a.instance.name}/${a.decision.to}`
    : null;
}

function onboardingRows(assessments: AnyAssessment[], coverage: ScanCoverage): OnboardingRow[] {
  const failed = new Set(coverage.lookupsFailed.map((l) => `${l.ecosystem}:${l.name}`));
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
        // The scan recorded this package's registry lookup as failed (D-52).
        lookupFailed: failed.has(`${a.instance.ecosystem}:${a.instance.name}`),
        target: a.decision?.kind === "upgrade" ? a.decision.to : null,
        majorsBehind: behind,
        deprecated: a.deprecation ? a.deprecation.summary : null,
        verdict: a.summary?.verdict ?? null,
        breakingSites: (a.summary?.breaking ?? []).reduce((n, f) => n + f.callSites.length, 0),
        coverage: c ? `${c.filesScanned} files, ${c.resolutionLevel}-resolved` : null,
      };
    });
}

/**
 * The scan itself, shared by installed repos and public scans (C3, C9): every ecosystem's
 * assessment, the API hosts and models the code calls, and runtimes; the records, findings and
 * inventory are stored for the scan. GitHub writes (onboarding PR, check run, fix runs, the
 * Dashboard issue) stay with the caller.
 */
export async function assessCheckout(
  db: Database,
  input: {
    repoId: number;
    scanId: string;
    fullName: string;
    dir: string;
    tree: ReturnType<typeof directoryTree>;
    config: TeireConfig;
    sha: string;
    /** An installation token, or the requester's own for a public scan; none reads anonymously. */
    token?: string;
    /** Why model work is paused, when it is (S10): page reading and triage are skipped. */
    blocked: string | null;
    /** Providers whose pages just yielded new records: other repos using them rescan (D95). */
    onProviderChanges?: (slugs: string[]) => Promise<void>;
  },
) {
  const { repoId, scanId, fullName, dir, tree, config, sha, blocked } = input;
  const [owner = "", name = ""] = fullName.split("/");
  // What this scan could not check (advisory sources down, registries that did not answer), D96.
  const coverage = newScanCoverage();
  const auth = { ...(input.token ? { githubToken: input.token } : {}), coverage };
  const on = config.ecosystems;
  const none = { projects: [], assessments: [] };
  const cache = postgresRegistryCache(db);
  const js = !on.npm
    ? none
    : await assessJsRepo(dir, tree, {
        cache,
        cooldownDays: config.upgrades.cooldownDays,
        ...auth,
        surfaceDiff: (n, f, t) => cachedSurfaceDiff(db, "npm", n, f, t, { cache }),
      });
  const py = !on.pypi
    ? none
    : await assessPyRepo(dir, tree, {
        cache,
        cooldownDays: config.upgrades.cooldownDays,
        ...auth,
        surfaceDiff: (n, f, t) => cachedSurfaceDiff(db, "pypi", n, f, t, { cache }),
      });
  const go = !on.go
    ? none
    : await assessGoRepo(dir, tree, {
        cache,
        cooldownDays: config.upgrades.cooldownDays,
        ...auth,
        surfaceDiff: (oldPath, f, newPath, t) =>
          cachedSurfaceDiff(db, "go", oldPath, f, t, { cache }, () => goSurfaceDiff(oldPath, f, newPath, t)),
      });
  const rust = !on.cargo
    ? none
    : await assessRustRepo(dir, tree, {
        cache,
        cooldownDays: config.upgrades.cooldownDays,
        ...auth,
        surfaceDiff: (n, f, t) =>
          cachedSurfaceDiff(db, "cargo", n, f, t, { cache }, async () =>
            cargoSurfaceDiff(n, f, t, { backend: (await selectBackend()).backend }),
          ),
      });
  const ruby = !on.rubygems
    ? none
    : await assessRubyRepo(dir, tree, {
        cache,
        cooldownDays: config.upgrades.cooldownDays,
        ...auth,
        surfaceDiff: (n, f, t) => cachedSurfaceDiff(db, "rubygems", n, f, t, { cache }),
      });
  const jvm = !on.maven
    ? none
    : await assessJvmRepo(dir, tree, {
        cache,
        cooldownDays: config.upgrades.cooldownDays,
        ...auth,
        surfaceDiff: (n, f, t) => cachedSurfaceDiff(db, "maven", n, f, t, { cache }),
      });
  const projects: AssessedProject[] = [
    ...js.projects,
    ...py.projects,
    ...go.projects,
    ...rust.projects,
    ...ruby.projects,
    ...jvm.projects,
  ];
  // Provider changes (S04, D82): only for the API providers this repo talks to, read on demand.
  const api = !on.apis
    ? {
        // `ecosystems.apis: false`: no API-host or model checks for this repo.
        scan: { hits: [], filesScanned: 0, languages: [], ms: 0 },
        findings: [],
        providers: [],
        records: [],
        discovery: { candidates: 0, usage: [], notes: [] },
        receipts: [],
        openapiNotes: [],
      }
    : await assessApiChanges(
        dir,
        tree,
        projects.flatMap((p) => p.instances),
        {
          changes: storedProviderChanges(
            db,
            async (slugs) => {
              await revalidateWeb(["catalog"]);
              await input.onProviderChanges?.(slugs);
            },
            !blocked,
          ),
          discover: { cache },
          ...(blocked ? {} : { triage: await pageReader(db) }),
          openapi: { cache, ...auth, repo: { owner, name, sha } },
          declared: config.sources,
        },
      );
  for (const n of api.openapiNotes) console.log(`[scan] ${fullName}: openapi ${n}`);
  // Nemotron tracing wrapped model IDs during the scan: recorded like any other model call.
  for (const r of api.receipts)
    if (!r.cached)
      await recordLlmCall(db, {
        runId: null,
        purpose: "triage",
        step: fullName,
        model: r.model,
        tokensIn: r.tokensIn,
        tokensCached: r.tokensCached,
        tokensOut: r.tokensOut,
        costUsd: r.costUsd.toFixed(6),
        latencyMs: r.ms,
      });
  if (api.discovery.candidates)
    console.log(
      `[scan] ${fullName}: ${api.discovery.candidates} provider(s) with no reader; found ${
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
    await upsertFinding(db, repoId, scanId, f, runtimeHashes.get(f.changeId) ?? "");
  const recordHashes = new Map(api.records.map((r) => [r.id, changeHash(r)]));
  for (const f of api.findings)
    await upsertFinding(db, repoId, scanId, f, recordHashes.get(f.changeId) ?? "");
  const assessments: AnyAssessment[] = [
    ...js.assessments,
    ...py.assessments,
    ...go.assessments,
    ...rust.assessments,
    ...ruby.assessments,
    ...jvm.assessments,
  ];
  await saveInstances(
    db,
    scanId,
    repoId,
    projects.flatMap((p) => p.instances),
  );
  for (const a of assessments) {
    const hashes = new Map<string, string>();
    for (const record of [...a.records, ...(a.deprecation ? [a.deprecation] : [])])
      hashes.set(record.id, await upsertChange(db, record));
    for (const f of a.findings) await upsertFinding(db, repoId, scanId, f, hashes.get(f.changeId) ?? "");
  }
  // Ignored targets stay ignored across scans, new findings included.
  if (config.ignore.length)
    await setFindingsState(db, repoId, (f) => config.ignore.some((t) => matchesTarget(t, f)), "ignored");
  // What this scan no longer reports is gone (a superseded target, a removed or upgraded package),
  // but only when every lookup answered: a failed one must not read as "fixed" (D96).
  if (lookupsAnswered(coverage)) await retireUnreported(db, repoId, scanId);
  // Rule 8: packages in ecosystems Teire can't upgrade (Packagist, NuGet, Pub…) are reported with
  // their advisories, never "clean". osv-scanner reads the lockfiles offline (D56).
  const others = (await osvExtract(dir).catch(() => null))?.others ?? [];
  if (others.length) {
    const byEcosystem = new Map<string, OtherPackage[]>();
    for (const p of others) byEcosystem.set(p.ecosystem, [...(byEcosystem.get(p.ecosystem) ?? []), p]);
    const found = await osvAdvisoryIds(others).catch(() => null);
    for (const [ecosystem, list] of byEcosystem)
      coverage.detectOnly.push({
        ecosystem,
        packages: new Set(list.map((p) => `${p.name}@${p.version}`)).size,
        advisories: found
          ? found
              .filter((f) => f.ecosystem === ecosystem)
              .map(({ name, version, ids }) => ({ name, version, ids }))
          : null,
      });
  }
  return { js, py, go, rust, ruby, jvm, projects, assessments, api, runtimes, coverage };
}

export async function scanRepo(
  ctx: WorkerContext,
  repoId: number,
  trigger: "install" | "push" | "command" | "manual" | "catalog",
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
  // Install journeys with nothing to scan get a named outcome on a stored scan (card C1), never a
  // silent failure: an archived repository is read-only (no onboarding PR can be opened), and an
  // empty one has no commit yet.
  const outcome = async (skipped: "archived" | "empty", sha: string | null) => {
    const scan = await startScan(db, repoId, trigger);
    await finishScan(db, scan.id, { status: "done", sha, coverage: { skipped } });
    await setRepo(db, repoId, { lastScannedAt: new Date(), ...(sha ? { lastScannedSha: sha } : {}) });
    return { skipped };
  };
  // `pullRequests.targetBranch` (C8), from the config the previous scan stored: scans, fixes and PRs use it.
  const branch = await installation.octokit.rest.repos
    .getBranch({
      owner,
      repo: name,
      branch: (repo.config as TeireConfig | null)?.pullRequests?.targetBranch || repo.defaultBranch,
    })
    .then((r) => r.data)
    .catch((error: { status?: number }) => {
      // 409 "Git Repository is empty"; 404 when the default branch has no commit.
      if ((error.status === 409 || error.status === 404) && (meta.size === 0 || error.status === 409))
        return null;
      throw error;
    });
  if (!branch) return outcome("empty", null);
  const sha = branch.commit.sha;
  if (meta.archived) return outcome("archived", sha);
  const scan = await startScan(db, repoId, trigger);
  let dir: string | null = null;
  try {
    const checkout = await fetchRepoTarball(owner, name, sha, { token });
    dir = checkout.dir;
    // Config: the repo's file over `<org>/teire-config` over defaults (C8); `@teire ignore` adds to it.
    const orgText = await readOrgConfig(installation.octokit, owner);
    const config = readTeireConfig(
      directoryTree(checkout.dir),
      orgText ? { orgText, orgFile: `${owner}/teire-config/teire.yml` } : {},
    );
    config.ignore = [...new Set([...config.ignore, ...((repo.ignores as string[] | null) ?? [])])];
    const tree = scopedTree(directoryTree(checkout.dir), config);
    // Model work (provider pages, wrapped-model triage) waits while credits or the budget are out (S10).
    const blocked = await modelWorkBlocked(db);
    if (blocked) console.log(`[scan] ${repo.fullName}: model reading skipped: ${blocked}`);
    const {
      js,
      py,
      go,
      rust,
      ruby,
      jvm,
      projects,
      assessments,
      api,
      runtimes,
      coverage: gaps,
    } = await assessCheckout(db, {
      repoId,
      scanId: scan.id,
      fullName: repo.fullName,
      dir: checkout.dir,
      tree,
      config,
      sha,
      token,
      blocked,
      onProviderChanges: (slugs) => fanOutProviderChanges(ctx, repoId, slugs),
    });
    await setRepoProviders(
      db,
      repoId,
      api.providers.map((p) => p.provider.slug),
    );
    // Nothing in the six ecosystems and no API or model in the code: no onboarding PR (card C1).
    // Packages in ecosystems Teire can't upgrade (PHP, .NET…) still count: their inventory and
    // advisories are reported, never "nothing here" (rule 8, S-M14).
    const nothingReadable =
      !projects.length && !api.findings.length && !runtimes.findings.length && !gaps.detectOnly.length;
    const coverage = {
      ...(assessments.find((a) => a.located)?.located?.coverage ?? {}),
      advisoryStatus: advisoryStatus(gaps),
      gaps: coverageLines(gaps),
      detectOnly: gaps.detectOnly,
      ...(nothingReadable ? { nothingReadable: true, searched: SEARCHED } : {}),
    };
    await finishScan(db, scan.id, { status: "done", sha, coverage });
    await setRepo(db, repoId, {
      lastScannedSha: sha,
      lastScannedAt: new Date(),
      languages: languagesOf({ js, py, go, rust, ruby, jvm }),
      config,
      configSource: config.path ?? (orgText ? `${owner}/teire-config` : null),
    });
    if (config.present || orgText)
      await publishConfigCheckRun({
        octokit: installation.octokit,
        owner,
        repo: name,
        headSha: sha,
        issues: config.issues,
      }).catch((error) => console.error(`[scan] ${repo.fullName}: config check run: ${error}`));

    let status = repo.status;
    // A teire.yml on the default branch activates, whether the onboarding PR or a person put it there.
    if ((status === "detected" || status === "onboarding") && config.present) status = "active";
    if (status === "detected" && nothingReadable) return { status, nothingReadable: true };
    const onboarding = () =>
      composeOnboarding({
        repo: { owner, repo: name, baseSha: sha },
        rows: onboardingRows(assessments, gaps),
        apiFindings: [...api.findings, ...runtimes.findings],
        gaps: coverageLines(gaps),
        issuesEnabled: meta.has_issues,
        ...(ctx.webUrl ? { dashboardUrl: `${ctx.webUrl}/app/repos/${repo.fullName}` } : {}),
      });
    if (status === "onboarding") {
      // The open onboarding PR says what this scan found. Only its text changes: the branch keeps
      // its commit (and any a person added), and a closed PR stays closed (that is an opt-out).
      const { data: open } = await installation.octokit.rest.pulls.list({
        owner,
        repo: name,
        head: `${owner}:${ONBOARDING_BRANCH}`,
        state: "open",
      });
      const pr = open[0];
      if (pr) {
        const { title, body } = onboarding();
        if (pr.body !== body || pr.title !== title)
          await installation.octokit.rest.pulls.update({
            owner,
            repo: name,
            pull_number: pr.number,
            title,
            body,
          });
      }
      return { status, ...(pr ? { onboarding: pr.html_url } : {}) };
    }
    if (status === "detected") {
      // Onboarding PR: the inventory, what Teire would do, and the config file whose merge activates it.
      const { title, body } = onboarding();
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
    // What Teire can't fix on its own gets a "needs a human" issue (D96), fixes paused or not.
    await syncHumanIssues(ctx, repoId).catch((error) =>
      console.error(`[scan] ${repo.fullName}: human issues: ${error}`),
    );
    // Fixes paused (D110): the scan and the Dashboard issue are kept current; no run is queued.
    // Paused fixes also keep their PRs as they are.
    if (!repo.fixesPaused && lookupsAnswered(gaps))
      await closeStalePullRequests(
        ctx,
        installation.octokit,
        repo,
        sha,
        assessments,
        // What this scan would still propose (plain bumps have no finding but keep their PR).
        new Set(
          assessments.flatMap((a) => {
            const g = groupKeyOf(a);
            return g && a.decision?.kind === "upgrade"
              ? [lineageKey(g, a.purpose === "security" ? "security" : "version")]
              : [];
          }),
        ),
      ).catch((error) => console.error(`[scan] ${repo.fullName}: stale PRs: ${error}`));
    if (repo.fixesPaused) {
      await syncDashboard(ctx, repoId).catch((error) =>
        console.error(`[scan] ${repo.fullName}: dashboard: ${error}`),
      );
      return { status, fixes: "paused" };
    }

    // Active: enqueue one run per group, best first (D70 queue: provider changes that already broke
    // the repo outrank majors); the fix job applies the PR caps.
    const queue = [
      ...fixCandidates(assessments, config).flatMap((a) => {
        const groupKey = groupKeyOf(a);
        return groupKey && a.decision?.kind === "upgrade"
          ? [
              {
                groupKey,
                lineage: lineageKey(groupKey, a.purpose === "security" ? "security" : "version"),
                priority: a.priority ?? 9,
                from: a.instance.version,
                to: a.decision.to,
              },
            ]
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
        lineageKey: "lineage" in c ? c.lineage : lineageKey(c.groupKey),
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
    // The Dashboard issue follows every scan of an active repo (C7).
    await syncDashboard(ctx, repoId).catch((error) =>
      console.error(`[scan] ${repo.fullName}: dashboard: ${error}`),
    );
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

/**
 * Provider fan-out (D95): a scan read a provider's pages and found new or changed records, so every
 * other active repo whose last scan used that provider is rescanned, and learns of the change
 * without waiting for its own push or schedule. Repos scanned in the last hour, or with
 * `schedule: off`, are left alone.
 */
async function fanOutProviderChanges(ctx: WorkerContext, fromRepoId: number, slugs: string[]) {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    select distinct r.id from repo_providers rp join repos r on r.id = rp.repo_id
    where rp.provider_slug in (${sql.join(
      slugs.map((s) => sql`${s}`),
      sql`, `,
    )})
      and r.id <> ${fromRepoId} and r.status = 'active'
      and coalesce(r.config->>'schedule', 'daily') <> 'off'
      and (r.last_scanned_at is null or r.last_scanned_at < now() - interval '1 hour')
  `);
  for (const r of rows) await ctx.enqueueScan?.(Number(r.id), "catalog");
  if (rows.length) console.log(`[scan] ${slugs.join(", ")}: new records; rescanning ${rows.length} repo(s)`);
}

/**
 * A Teire PR whose lineage this scan no longer reports closes with the reason (C6, S15.8): the
 * package was removed or upgraded on the base branch, or the change no longer applies. Called only
 * when every lookup answered (D96), so a registry outage never closes a PR.
 */
async function closeStalePullRequests(
  ctx: WorkerContext,
  octokit: Awaited<ReturnType<WorkerContext["gh"]["installation"]>>["octokit"],
  repo: NonNullable<Awaited<ReturnType<typeof getRepo>>>,
  sha: string,
  assessments: { instance: { ecosystem: string; name: string; version: string | null } }[],
  proposed: ReadonlySet<string>,
) {
  const live = await openLineages(ctx.db, repo.id);
  for (const l of proposed) live.add(l);
  const [owner = "", name = ""] = repo.fullName.split("/");
  for (const a of await openArtifacts(ctx.db, repo.id)) {
    if (a.kind !== "pr" || !a.number || live.has(a.lineageKey ?? lineageKey(a.changeKey))) continue;
    const parts = a.changeKey.split("/");
    const pkg = parts.slice(1, -1).join("/");
    const installed = [
      ...new Set(
        assessments
          .filter((x) => x.instance.ecosystem === parts[0] && x.instance.name === pkg && x.instance.version)
          .map((x) => x.instance.version),
      ),
    ];
    const at = `\`${repo.defaultBranch}\` (\`${sha.slice(0, 7)}\`)`;
    const why = !(ECOSYSTEMS as readonly string[]).includes(parts[0] ?? "")
      ? `The latest scan of ${at} no longer finds code this change affects.`
      : installed.length
        ? `\`${pkg}\` is at ${installed.join(", ")} on ${at} now, so this upgrade to ${parts.at(-1)} no longer applies.`
        : `\`${pkg}\` is no longer a dependency on ${at}.`;
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo: name,
        issue_number: a.number,
        body: `Closing: ${why}`,
      });
      await octokit.rest.pulls.update({ owner, repo: name, pull_number: a.number, state: "closed" });
      await upsertArtifact(ctx.db, { ...a, state: "closed" });
    } catch (error) {
      console.error(`[scan] ${repo.fullName}#${a.number}: close: ${error}`);
    }
  }
}
