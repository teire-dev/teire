import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { matchesTarget, readTeireConfig, type TeireConfig } from "@teire/engine/config";
import { RUNS } from "@teire/engine/constants";
import { type CallSite, type ChangeV2, type Ecosystem, lineageKey } from "@teire/engine/contract";
import { cargoFeatureOverlay, type FixRun, type Transaction, withGradleLocks } from "@teire/engine/fix";
import {
  branchFor,
  commitToBranch,
  composeHumanIssue,
  HumanCommitsError,
  modelName,
  openOrUpdatePullRequest,
  publishCheckRun,
} from "@teire/engine/github";
import type { JvmProject, PyProject, RepoTree, RubyProject, RustProject } from "@teire/engine/inventory";
import { directoryTree, fetchRepoTarball, scopedTree } from "@teire/engine/inventory";
import {
  CreditsExhaustedError,
  createTokenFactory,
  fetchModelPrices,
  tokenFactoryConfigFromEnv,
} from "@teire/engine/llm";
import {
  type AssessedProject,
  type Assessment,
  assessApiChanges,
  assessGoRepo,
  assessJsRepo,
  assessJvmRepo,
  assessPyRepo,
  assessRubyRepo,
  assessRustRepo,
  fixApiChanges,
  fixGoDependency,
  fixJsDependency,
  fixJvmDependency,
  fixPyDependency,
  fixRubyDependency,
  fixRustDependency,
  type GoAssessment,
  repoInstances,
} from "@teire/engine/pipeline";
import {
  jobSettings,
  PACKAGE_MANAGER,
  ResolverUnavailableError,
  readDependabotConfig,
  resolverTransaction,
  type TeireManager,
  updateFor,
} from "@teire/engine/resolver";
import { cargoSurfaceDiff, goSurfaceDiff } from "@teire/engine/surface";
import { selectBackend } from "@teire/engine/verify";
import { cachedSurfaceDiff, postgresRegistryCache } from "../caches";
import { markCreditsExhausted, modelWorkBlocked } from "../reliability";
import { resolveForRepo } from "../resolver";
import {
  appendEvent,
  claimRun,
  getArtifact,
  getRepo,
  getRun,
  openArtifacts,
  prCounts,
  recordLlmCall,
  recordSandboxExec,
  runEventsOf,
  updateRun,
  upsertArtifact,
} from "../store";
import { readOrgConfig } from "./commands";
import { syncDashboard } from "./dashboard";
import { pageReader, storedProviderChanges } from "./providers";
import { requesterToken } from "./public";
import type { WorkerContext } from "./scan";

/** A run deferred for credits or the daily budget tries again after this long. */
const BUDGET_RETRY_SECONDS = 30 * 60;
const DEFER_SECONDS = 3600;
/** An unreachable resolver queues the run this many times, this far apart, then it is a named stop. */
const RESOLVER_RETRIES = 3;
const RESOLVER_RETRY_SECONDS = 15 * 60;

/**
 * Ecosystems whose dependency-file change dependabot-core's updater decides (S15 rollout): each joins
 * `TEIRE_RESOLVER_ECOSYSTEMS` once its upgrade passes on a real fork. There is no fallback for them:
 * a refusal is a named stop and an outage queues (D104). Others keep Teire's own transaction.
 */
function resolverDecides(ecosystem: Ecosystem) {
  return (process.env.TEIRE_RESOLVER_ECOSYSTEMS ?? "")
    .split(",")
    .map((e) => e.trim())
    .includes(ecosystem);
}

/**
 * Lockfiles dependabot-core's updater can't handle although the package manager reads them, so
 * Teire's own transaction keeps them (D104), as found in the pilot (2026-10-28):
 * - pnpm lockfiles before v6 (pnpm 7): its pnpm helper reads importer `specifiers` that v5.4
 *   lockfiles don't carry, and fails ("pnpm-lock.yaml not parseable");
 * - Bun's binary `bun.lockb`: it reads only the text `bun.lock`, so the lockfile would stay stale.
 */
function dependabotCannotParse(tree: RepoTree, project: { manager: string; root: string }) {
  const at = (file: string) => (project.root === "." ? file : `${project.root}/${file}`);
  if (project.manager === "bun")
    return tree.read(at("bun.lock")) === null && tree.files().includes(at("bun.lockb"));
  if (project.manager !== "pnpm") return false;
  const version = tree.read(at("pnpm-lock.yaml"))?.match(/^lockfileVersion: ['"]?(\d+)/m)?.[1];
  return !!version && Number(version) < 6;
}

/**
 * The updater's security job from the advisories Teire matched (S15.7). Only affected ranges are
 * given, since a safe range overrides them in dependabot-core: GitHub's own range where the advisory
 * has one (the format Dependabot reads), else everything below Teire's lowest published fix.
 */
function securityAdvisories(name: string, records: ChangeV2[], target: string) {
  // An advisory with no published fix would make the whole job impossible (every version stays
  // vulnerable to it); it stays out of the job, and the PR says this upgrade doesn't fix it.
  return records
    .filter((r) => r.kind === "security-advisory" && r.applicability.fixedIn.length > 0)
    .map((r) => ({
      dependencyName: name,
      affectedVersions: [r.applicability.affectedRange ?? `< ${target}`],
      patchedVersions: [],
      unaffectedVersions: [],
    }));
}

/**
 * Why the updater stopped below T (D103), named where the cause is known rather than restated:
 * Maven keeps a version's qualifier (D-6), so a target that adds or changes one is never taken.
 */
function belowTargetReason(
  ecosystem: Ecosystem,
  name: string,
  from: string | null,
  lead: string | null,
  target: string,
  warnings: string[],
) {
  const base = `dependabot-core's updater resolves ${name} only up to ${lead}, not ${target}`;
  const qualifier = (v: string | null) => v?.match(/^[\d.]+([-.]?[A-Za-z].*)?$/)?.[1] ?? "";
  const cause =
    ecosystem === "maven" && qualifier(target) !== qualifier(from)
      ? `its Maven version finder takes only versions whose suffix matches the installed one (dependabot-core \`suffix_compatible?\`), and ${target} has "${qualifier(target)}" where ${from} has ${qualifier(from) ? `"${qualifier(from)}"` : "none"}`
      : null;
  return [cause ? `${base}: ${cause}` : base, ...warnings].join("; ");
}

/** The updater refused the upgrade, with its typed reason, quoted on the run and in an issue. */
class ResolverStopError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

/** The updater found nothing to change for this target (every newer version ignored, say). */
class ResolverNothingError extends Error {}

/** What a fix produced, whatever was fixed (a package upgrade or a provider's API change). */
interface Outcome {
  /** Set when the target moved during the run (D103: the updater resolved only up to it). */
  groupKey?: string;
  targetVersion?: string;
  /** D71: the major failed its checks after the agent's attempts; the next run targets this one. */
  fallback?: { version: string; reason: string };
  fix: FixRun;
  pr: { title: string; body: string };
  notesReceipt: { model: string; tokensIn: number; tokensOut: number; costUsd: number; ms: number } | null;
  labels: string[];
  checkTitle: string;
  sites: (CallSite & { message: string })[];
}

type Common = Omit<Parameters<typeof fixJsDependency>[0], "assessment">;

const PACKAGE_ECOSYSTEMS = ["npm", "pypi", "go", "cargo", "rubygems", "maven"] as const;

/** The ecosystem a package group key starts with, or null for a provider group (`models/…`, `api/…`). */
export function packageEcosystemOf(head: string): (typeof PACKAGE_ECOSYSTEMS)[number] | null {
  return (PACKAGE_ECOSYSTEMS as readonly string[]).includes(head)
    ? (head as (typeof PACKAGE_ECOSYSTEMS)[number])
    : null;
}

/** Teire's manager names as the resolver's job wants them; null where the updater can't run. */
function resolverManager(manager: string): TeireManager | null {
  if (manager === "pip-tools") return "pip-compile";
  if (manager === "uv-pip") return "pip";
  return (
    (
      [
        "npm",
        "yarn",
        "pnpm",
        "bun",
        "pip",
        "pipenv",
        "poetry",
        "uv",
        "go",
        "cargo",
        "bundler",
        "maven",
        "gradle",
      ] as const
    ).find((m) => m === manager) ?? null
  );
}

/**
 * The dependency-file change from dependabot-core's updater (S15.1, D92), one job across every
 * lockfile root that declares the package at this target (D94). Teire's own transaction stays
 * where D104 keeps it: Go majors (a new module path), renamed or aliased packages, `pylock.toml`
 * and, until advisories ride along in the job, security updates. When the updater stops or lands
 * below the target, the run says why and uses Teire's own transaction.
 */
async function resolverTransactionFor(
  ctx: WorkerContext,
  repo: { id: number; installationId: number | null; isPrivate: boolean | null },
  ecosystem: Ecosystem,
  packageName: string,
  target: string,
  assessment: Assessment<AssessedProject>,
  matching: Assessment<AssessedProject>[],
  config: TeireConfig,
  tree: RepoTree,
  common: Common,
): Promise<Transaction | { cap: { version: string; reason: string; floor?: boolean } } | null> {
  const manager = resolverManager(assessment.project.manager);
  const keep =
    !manager ||
    !!assessment.instance.aliasName ||
    dependabotCannotParse(tree, assessment.project) ||
    (ecosystem === "go" && assessment.decision?.kind === "upgrade" && assessment.decision.isMajor);
  if (keep || !manager || !resolverDecides(ecosystem)) return null;
  // Every root the same Dependabot package manager covers (npm and Yarn roots share npm_and_yarn).
  const dependabotManager = PACKAGE_MANAGER[manager];
  const roots = [
    ...new Set(
      matching
        .filter((m) => {
          const other = resolverManager(m.project.manager);
          return !!other && PACKAGE_MANAGER[other] === dependabotManager;
        })
        .map((m) => m.project.root),
    ),
  ];
  const { options, conflicts } = jobSettings(
    updateFor(readDependabotConfig(tree), manager, assessment.project.root),
    config,
  );
  for (const c of conflicts) common.onEvent?.({ step: "transaction", detail: `config: ${c}` });
  // The Cargo pre-step (D104): features the target removed are dropped from the updater's input.
  const removedFeatures =
    ecosystem === "cargo"
      ? (assessment.diff?.changes ?? [])
          .filter((c) => c.kind === "removed" && c.path.startsWith("feature:"))
          .map((c) => c.path.slice("feature:".length))
      : [];
  const overlay = removedFeatures.length
    ? cargoFeatureOverlay(tree, assessment.project as RustProject, assessment.instance, removedFeatures)
    : [];
  if (overlay.length)
    common.onEvent?.({
      step: "transaction",
      detail: `features ${target} removed are dropped before the updater runs: ${removedFeatures.join(", ")}`,
    });
  const resolved = await resolveForRepo(
    ctx,
    repo,
    {
      manager,
      ecosystem,
      repo: `${common.repo.owner}/${common.repo.repo}`,
      commit: common.repo.baseSha,
      roots,
      shape:
        assessment.purpose === "security"
          ? {
              kind: "security",
              dependency: packageName,
              advisories: securityAdvisories(packageName, assessment.records, target),
            }
          : { kind: "version", dependency: packageName, target },
      ...options,
      ...(overlay.length ? { overlay } : {}),
      ...(repo.isPrivate ? { repoPrivate: true } : {}),
    },
    { ecosystem, name: packageName },
    common.runId,
  );
  if (!resolved) throw new ResolverUnavailableError("the worker has no resolver configured");
  const r = resolved.result;
  if (r.kind === "stop") throw new ResolverStopError(r.type, r.message);
  if (r.kind === "close") throw new ResolverNothingError(`nothing to change: ${r.reason}`);
  if (r.kind === "nothing")
    throw new ResolverNothingError(
      [`no update to ${target} (the updater's log has the details)`, ...r.warnings].join("; "),
    );
  if (!r.leadVersion)
    throw new ResolverStopError(
      "unreported_version",
      `the updater changed ${r.files.map((f) => f.path).join(", ")} without saying which version of ${packageName} it chose`,
    );
  const bare = (v: string | null) => v?.replace(/^v(?=\d)/, "") ?? null;
  if (bare(r.leadVersion) !== bare(target)) {
    // A security job's lowest resolvable fix is above the lowest published one (that one doesn't
    // resolve here): it becomes the target, as Dependabot's own security update would.
    if (assessment.purpose === "security" && r.leadVersion) {
      const reason = `${target} is the lowest version that fixes the advisory, but dependabot-core's updater can resolve ${packageName} only from ${r.leadVersion} in this repository`;
      common.onEvent?.({ step: "transaction", detail: reason });
      return { cap: { version: r.leadVersion, reason, floor: true } };
    }
    // D103: below T becomes the target, diffed again; the reason goes on the run and the PR.
    const reason = belowTargetReason(
      ecosystem,
      packageName,
      assessment.instance.version,
      r.leadVersion,
      target,
      r.warnings,
    );
    common.onEvent?.({ step: "transaction", detail: reason });
    return r.leadVersion ? { cap: { version: r.leadVersion, reason } } : null;
  }
  common.onEvent?.({
    step: "transaction",
    detail: `dependabot-core's updater changed ${r.files.map((f) => f.path).join(", ")} across ${roots.length} root${roots.length === 1 ? "" : "s"}${resolved.cached ? " (cached)" : ""}`,
  });
  const tx = resolverTransaction(
    r,
    (path) => {
      try {
        return readFileSync(join(common.repoDir, path), "utf8");
      } catch {
        return null;
      }
    },
    { name: packageName, from: assessment.instance.version },
  );
  // Gradle locks are re-locked by Teire for this coordinate only, in every root the job covered.
  return matching
    .filter((m) => m.project.manager === "gradle")
    .reduce((t, m) => withGradleLocks(t, m.project as JvmProject, packageName, target), tx);
}

/** A package group (`npm/openai/7.38.0`): re-assess that package, then upgrade and fix it. */
async function packageOutcome(
  ctx: WorkerContext,
  repo: { id: number; installationId: number | null; isPrivate: boolean | null },
  run: {
    groupKey: string;
    targetVersion: string;
    fromVersion: string | null;
    fallbackMajors?: number;
    fallbackFrom?: { version: string; reason: string };
  },
  repoDir: string,
  tree: RepoTree,
  config: TeireConfig,
  token: string | undefined,
  common: Common,
  cap?: { version: string; reason: string; floor?: boolean },
): Promise<Outcome | null> {
  // A package group key is `<ecosystem>/<name>/<target>` with the contract's ecosystem names.
  const head = run.groupKey.split("/")[0] ?? "";
  const ecosystem = packageEcosystemOf(head);
  if (!ecosystem) throw new Error(`run ${run.groupKey}: not a package group`);
  const packageName = run.groupKey.split("/").slice(1, -1).join("/");
  const cache = postgresRegistryCache(ctx.db);
  const assessOptions = {
    cache,
    cooldownDays: config.upgrades.cooldownDays,
    onlyPackage: packageName,
    ...(cap ? { targetMax: { name: packageName, version: cap.version, reason: cap.reason } } : {}),
    ...(cap?.floor ? { targetFloor: { name: packageName, version: cap.version } } : {}),
    ...(run.fallbackMajors ? { fallbackMajors: run.fallbackMajors } : {}),
    ...(token ? { githubToken: token } : {}),
    surfaceDiff: (n: string, f: string, t: string) =>
      cachedSurfaceDiff(ctx.db, ecosystem, n, f, t, { cache }),
  };
  const assess = async (extra: { fallbackMajors?: number } = {}) => {
    const options = { ...assessOptions, ...extra };
    return (
      ecosystem === "pypi"
        ? await assessPyRepo(repoDir, tree, options)
        : ecosystem === "go"
          ? await assessGoRepo(repoDir, tree, {
              ...options,
              surfaceDiff: (oldPath, f, newPath, t) =>
                cachedSurfaceDiff(ctx.db, "go", oldPath, f, t, { cache }, () =>
                  goSurfaceDiff(oldPath, f, newPath, t),
                ),
            })
          : ecosystem === "cargo"
            ? await assessRustRepo(repoDir, tree, {
                ...options,
                surfaceDiff: (n: string, f: string, t: string) =>
                  cachedSurfaceDiff(ctx.db, "cargo", n, f, t, { cache }, async () =>
                    cargoSurfaceDiff(n, f, t, { backend: (await selectBackend()).backend }),
                  ),
              })
            : ecosystem === "rubygems"
              ? await assessRubyRepo(repoDir, tree, options)
              : ecosystem === "maven"
                ? await assessJvmRepo(repoDir, tree, options)
                : await assessJsRepo(repoDir, tree, options)
    ).assessments as Assessment<AssessedProject>[];
  };
  const assessments = await assess();
  // Every lockfile root that declares the package at this target. The most urgent leads; the run
  // names the others (one PR per package per repo, D94; the resolver edits them all from S15).
  const matching = assessments
    .filter((a) => a.decision?.kind === "upgrade" && a.decision.to === run.targetVersion)
    // `@teire ignore` and teire.yml `ignore` apply to the run as they do to the scan (C8).
    .filter(
      (a) => !a.findings.length || a.findings.some((f) => !config.ignore.some((t) => matchesTarget(t, f))),
    )
    .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));
  const assessment = matching[0];
  if (!assessment) return null;
  const roots = [...new Set(matching.map((a) => a.project.root))];
  const resolved = await resolverTransactionFor(
    ctx,
    repo,
    ecosystem,
    packageName,
    run.targetVersion,
    assessment,
    matching,
    config,
    tree,
    common,
  );
  if (resolved && "cap" in resolved) {
    // Once only: the capped run's own job must land on the cap.
    if (cap)
      throw new ResolverStopError(resolved.cap.floor ? "fix_moved" : "below_target", resolved.cap.reason);
    const capped = `${run.groupKey.split("/").slice(0, -1).join("/")}/${resolved.cap.version}`;
    const outcome = await packageOutcome(
      ctx,
      repo,
      { ...run, groupKey: capped, targetVersion: resolved.cap.version },
      repoDir,
      tree,
      config,
      token,
      common,
      resolved.cap,
    );
    return outcome ? { ...outcome, groupKey: capped, targetVersion: resolved.cap.version } : null;
  }
  const transaction = resolved;
  if (roots.length > 1 && !transaction)
    common.onEvent?.({
      step: "transaction",
      detail: `${roots.length} lockfile roots declare ${packageName} at ${run.targetVersion} (${roots.join(", ")}); this run edits ${assessment.project.root}`,
    });
  const input = {
    ...common,
    ...(transaction ? { transaction } : {}),
    ...(run.fallbackFrom ? { fallbackFrom: run.fallbackFrom } : {}),
  };
  const result =
    ecosystem === "pypi"
      ? await fixPyDependency({ ...input, assessment: assessment as unknown as Assessment<PyProject> })
      : ecosystem === "go"
        ? await fixGoDependency({ ...input, assessment: assessment as unknown as GoAssessment })
        : ecosystem === "cargo"
          ? await fixRustDependency({
              ...input,
              assessment: assessment as unknown as Assessment<RustProject>,
            })
          : ecosystem === "rubygems"
            ? await fixRubyDependency({
                ...input,
                assessment: assessment as unknown as Assessment<RubyProject>,
              })
            : ecosystem === "maven"
              ? await fixJvmDependency({
                  ...input,
                  assessment: assessment as unknown as Assessment<JvmProject>,
                })
              : await fixJsDependency({ ...input, assessment: assessment as unknown as Assessment });
  // D71: a major whose checks still fail after the agent's attempts falls back one major, once.
  let fallback: Outcome["fallback"];
  if (
    result.run.exhausted &&
    result.run.attempts.length >= 2 &&
    assessment.decision?.kind === "upgrade" &&
    assessment.decision.isMajor &&
    !run.fallbackMajors
  ) {
    const lower = (await assess({ fallbackMajors: 1 })).find(
      (a) => a.decision?.kind === "upgrade" && a.project.root === assessment.project.root,
    );
    if (lower?.decision?.kind === "upgrade" && lower.decision.to !== run.targetVersion)
      fallback = {
        version: lower.decision.to,
        reason: `${result.run.attempts.length} attempt${result.run.attempts.length === 1 ? "" : "s"}; ${result.run.evidence.reasons.join("; ")}`,
      };
  }
  return {
    ...(fallback ? { fallback } : {}),
    fix: result.run,
    pr: result.pr,
    notesReceipt: result.notesReceipt,
    labels: [
      ecosystem,
      assessment.purpose === "security"
        ? "security"
        : assessment.decision?.kind === "upgrade" && assessment.decision.isMajor
          ? "major"
          : "upgrade",
    ],
    checkTitle: `${packageName} ${run.fromVersion} → ${run.targetVersion}`,
    sites: (assessment.summary?.breaking ?? []).flatMap((f) =>
      f.callSites.map((s) => ({
        ...s,
        message: `${f.changeKind.replace(/-/g, " ")} in ${packageName} ${run.targetVersion}: ${s.snippet.trim().slice(0, 200)}`,
      })),
    ),
  };
}

/** A provider group (`models/nebius-token-factory`): re-scan against the stored catalog, then swap and fix. */
async function apiOutcome(
  ctx: WorkerContext,
  run: { groupKey: string },
  repoDir: string,
  tree: RepoTree,
  config: TeireConfig,
  common: Common,
): Promise<Outcome | null> {
  const {
    findings,
    records: read,
    providers,
  } = await assessApiChanges(repoDir, tree, await repoInstances(repoDir, tree), {
    changes: storedProviderChanges(ctx.db),
    discover: { cache: postgresRegistryCache(ctx.db) },
    triage: await pageReader(ctx.db),
    openapi: {
      cache: postgresRegistryCache(ctx.db),
      githubToken: common.options.githubToken,
      repo: { owner: common.repo.owner, name: common.repo.repo, sha: common.repo.baseSha },
    },
    declared: config.sources,
  });
  const group = findings
    .filter((f) => f.groupKey === run.groupKey)
    .filter((f) => !config.ignore.some((t) => matchesTarget(t, f)));
  if (!group.some((f) => f.verdict === "affected")) return null;
  const records = read.filter((r) => group.some((f) => f.changeId === r.id));
  const slug = records[0]?.subject.provider;
  const result = await fixApiChanges({
    ...common,
    findings: group,
    records,
    related: read.filter((r) => r.subject.provider === slug),
    providerName: providers.find((p) => p.provider.slug === slug)?.provider.name,
  });
  return {
    fix: result.run,
    pr: result.pr,
    notesReceipt: null,
    labels: [run.groupKey.startsWith("models/") ? "model-retirement" : "api-change", ...(slug ? [slug] : [])],
    checkTitle: result.pr.title,
    sites: group
      .filter((f) => f.verdict === "affected")
      .flatMap((f) => f.callSites.map((s) => ({ ...s, message: f.reason }))),
  };
}

/**
 * A named stop reaches the repo as an issue (D104): what was asked, the updater's own words and what
 * to do. It is keyed by lineage, so the next run in the lineage that opens a PR closes it, and a
 * person's close is never undone (C6).
 */
async function openStopIssue(
  ctx: WorkerContext,
  octokit: Awaited<ReturnType<WorkerContext["gh"]["installation"]>>["octokit"],
  repo: NonNullable<Awaited<ReturnType<typeof getRepo>>>,
  run: NonNullable<Awaited<ReturnType<typeof getRun>>>,
  groupKey: string,
  reason: string,
) {
  // Per target: a later stop in the same lineage (a newer version) gets its own issue.
  const key = `stop/${run.lineageKey ?? lineageKey(groupKey)}@${groupKey.split("/").at(-1)}`;
  const [owner = "", name = ""] = repo.fullName.split("/");
  const existing = await getArtifact(ctx.db, repo.id, "issue", key);
  if (existing?.state === "open" && existing.number) {
    await octokit.rest.issues
      .createComment({ owner, repo: name, issue_number: existing.number, body: `Still stopped: ${reason}` })
      .catch(() => undefined);
    return;
  }
  if (existing) return;
  const parts = groupKey.split("/");
  const { title, body } = composeHumanIssue({
    repo: { owner, repo: name, baseSha: run.baseSha ?? "" },
    key: groupKey,
    rows: [
      {
        changeId: groupKey,
        title: `${parts.slice(1, -1).join("/")} ${run.fromVersion ?? "?"} → ${parts.at(-1)}`,
        verdict: "needs_human",
        reason,
        callSites: [],
      },
    ],
    records: [],
    webUrl: ctx.webUrl ? `${ctx.webUrl}/runs/${run.id}` : null,
  });
  const created = await octokit.rest.issues
    .create({ owner, repo: name, title, body, labels: ["teire"] })
    .catch(() => null);
  if (created)
    await upsertArtifact(ctx.db, {
      repoId: repo.id,
      kind: "issue",
      changeKey: key,
      lineageKey: run.lineageKey ?? lineageKey(groupKey),
      number: created.data.number,
      state: "open",
      url: created.data.html_url,
      runId: run.id,
    });
}

export async function fixRun(ctx: WorkerContext, runId: string) {
  const { db, gh } = ctx;
  const run = await getRun(db, runId);
  if (!run || run.status === "succeeded" || run.status === "cancelled") return { skipped: true };
  // A run the reaper failed (its worker stopped) is retried by its queue: it starts over cleanly.
  // Any other failure stays failed until someone asks again (`@teire recreate`).
  if (run.status === "failed" && run.step !== "interrupted") return { skipped: true };
  if (run.status === "failed" || run.status === "running")
    await updateRun(db, runId, { status: "queued", attempt: run.attempt + 1, error: null });
  const repo = await getRepo(db, run.repoId);
  // A dry run (C9) works on any public repo: no installation, no GitHub writes, no PR caps.
  const dry = run.kind === "dry_run";
  if (!repo || (!dry && !repo.installationId) || !run.groupKey || !run.targetVersion || !run.baseSha) {
    // Recorded on the run, so it shows as failed instead of waiting in the queue forever.
    await updateRun(db, runId, {
      status: "failed",
      step: "incomplete",
      error: `run ${runId} is incomplete: ${!repo ? "the repository is gone" : !dry && !repo.installationId ? "Teire is no longer installed on it" : "it has no group, target or base commit"}`,
      finishedAt: new Date(),
    });
    throw new Error(`run ${runId} is incomplete`);
  }
  let groupKey = run.groupKey;
  const isApi = /^(models|api)\//.test(groupKey);
  const [owner = "", name = ""] = repo.fullName.split("/");
  // A paused repo gets no PRs ("no scans or PRs until resume"), whatever started the run.
  if (!dry && repo.status === "paused") {
    await updateRun(db, runId, { status: "cancelled", step: "repository paused", finishedAt: new Date() });
    await appendEvent(db, runId, "queue", "cancelled", {
      reason: "the repository is paused; resume it to fix",
    });
    return { cancelled: "paused" };
  }
  // Fixes paused (`@teire pause-fixes`, D110): scans and the Dashboard issue go on, no run does.
  if (!dry && repo.fixesPaused) {
    await updateRun(db, runId, { status: "cancelled", step: "fixes paused", finishedAt: new Date() });
    await appendEvent(db, runId, "queue", "cancelled", {
      reason: "fixes are paused for this repository; `@teire resume-fixes` to fix",
    });
    return { cancelled: "fixes paused" };
  }
  const installation = repo.installationId && !dry ? await gh.installation(repo.installationId) : null;
  const event = (step: string, type: string, payload: object) => appendEvent(db, runId, step, type, payload);

  // Noise controls before any work (D70): per-repo open PRs and new PRs per hour.
  const config = (repo.config as ReturnType<typeof readTeireConfig> | null) ?? null;
  const limits = config?.pullRequests ?? { limit: 5, perHour: 2 };
  const counts = dry ? { open: 0, lastHour: 0 } : await prCounts(db, repo.id);
  if (counts.open >= limits.limit || counts.lastHour >= limits.perHour) {
    await updateRun(db, runId, { status: "queued", step: "waiting for the PR limit" });
    await event("queue", "deferred", { open: counts.open, lastHour: counts.lastHour, limits });
    await ctx.enqueueFix(runId, repo.id, DEFER_SECONDS);
    return { deferred: true };
  }

  // Money and the model service decide whether model work may start (S10).
  const blocked = await modelWorkBlocked(db);
  if (blocked) {
    await updateRun(db, runId, { status: "queued", step: "waiting for the model budget" });
    await event("queue", "deferred", { reason: blocked });
    await ctx.enqueueFix(runId, repo.id, BUDGET_RETRY_SECONDS);
    return { deferred: blocked };
  }

  // A run resumed after a deferral (credits, the updater) starts clean: the old reason is history.
  await updateRun(db, runId, { status: "running", step: "assess", startedAt: new Date(), error: null });
  // A heartbeat while the run works, so the reaper can tell a long sandbox step from a dead worker.
  const heartbeat = setInterval(
    () => void updateRun(db, runId, {}).catch(() => undefined),
    RUNS.heartbeatEveryMs,
  );
  await event("assess", "started", { group: groupKey, from: run.fromVersion, target: run.targetVersion });
  // A dry run reads GitHub as the person who asked (their own rate limit), anonymously without it.
  const token = installation ? await installation.token() : await requesterToken(db, run.requestedBy);
  let dir: string | null = null;
  try {
    const checkout = await fetchRepoTarball(owner, name, run.baseSha, token ? { token } : {});
    dir = checkout.dir;
    // The scan's own config: the repo's file over `<org>/teire-config` over defaults, plus
    // `@teire ignore` targets, and the same scoped tree (C8).
    const orgText = installation ? await readOrgConfig(installation.octokit, owner) : null;
    const runConfig = readTeireConfig(
      directoryTree(checkout.dir),
      orgText ? { orgText, orgFile: `${owner}/teire-config/teire.yml` } : {},
    );
    runConfig.ignore = [...new Set([...runConfig.ignore, ...((repo.ignores as string[] | null) ?? [])])];
    const tree = scopedTree(directoryTree(checkout.dir), runConfig);
    const tf = createTokenFactory(tokenFactoryConfigFromEnv());
    const prices = await fetchModelPrices().catch(() => undefined);
    const { backend, note } = await selectBackend();
    // A CI repair starts from what the repo's own CI said about the PR (C6: one repair attempt).
    const ci = run.requestedBy?.startsWith("ci-repair:")
      ? ((await runEventsOf(db, runId, "ci"))[0]?.payload as
          | { checks?: { name: string; url: string; log: string }[] }
          | undefined)
      : undefined;
    const extraNotes = (ci?.checks ?? []).map((c) => ({
      summary: `The repository's own CI check "${c.name}" failed on Teire's PR; fix what it reports (its log is the quote).`,
      apis: [],
      replacement: null,
      quote: c.log,
      url: c.url,
    }));
    const common: Common = {
      ...(extraNotes.length ? { extraNotes } : {}),
      ...(config?.verify?.length ? { verify: config.verify } : {}),
      tf,
      prices,
      backend,
      backendNote: note,
      runId,
      ...(ctx.webUrl ? { runUrl: `${ctx.webUrl}/runs/${runId}` } : {}),
      repoDir: checkout.dir,
      tree,
      repo: { owner, repo: name, baseSha: run.baseSha },
      tarball: {
        url: `https://api.github.com/repos/${owner}/${name}/tarball/${run.baseSha}`,
        ...(token ? { token } : {}),
      },
      options: {
        cache: postgresRegistryCache(db),
        ...(token ? { githubToken: token } : {}),
        context7Key: process.env.CONTEXT7_API_KEY,
      },
      onEvent: (e: { step: string }) => {
        void event(e.step, "log", e);
        void updateRun(db, runId, { step: e.step });
      },
    };
    await updateRun(db, runId, { step: "fix", backend: backend.name });
    // A fallback run (D71) carries the newer major it replaces, written when it was queued.
    const fallbackFrom = (await runEventsOf(db, runId, "fallback")).find((e) => e.type === "from")?.payload as
      | { version: string; reason: string }
      | undefined;
    const outcome = isApi
      ? await apiOutcome(ctx, { groupKey }, checkout.dir, tree, runConfig, common)
      : await packageOutcome(
          ctx,
          { id: repo.id, installationId: repo.installationId, isPrivate: repo.isPrivate },
          {
            groupKey,
            targetVersion: run.targetVersion,
            fromVersion: run.fromVersion,
            fallbackMajors: run.fallbackMajors,
            ...(fallbackFrom ? { fallbackFrom } : {}),
          },
          checkout.dir,
          tree,
          runConfig,
          token,
          common,
        );
    if (outcome?.groupKey && outcome.groupKey !== groupKey) {
      await event("transaction", "target-moved", { from: run.targetVersion, to: outcome.targetVersion });
      await updateRun(db, runId, {
        groupKey: outcome.groupKey,
        targetVersion: outcome.targetVersion ?? run.targetVersion,
        lineageKey: lineageKey(outcome.groupKey),
      });
      groupKey = outcome.groupKey;
    }
    if (!outcome) {
      await updateRun(db, runId, { status: "cancelled", step: "no longer applies", finishedAt: new Date() });
      await event("assess", "cancelled", { reason: "the change no longer applies to this repo" });
      return { cancelled: true };
    }
    const { fix, pr: composed, notesReceipt } = outcome;

    // Receipts: every model call and every sandbox command.
    if (notesReceipt)
      await recordLlmCall(db, {
        runId,
        purpose: "notes",
        step: "notes",
        model: notesReceipt.model,
        tokensIn: notesReceipt.tokensIn,
        tokensOut: notesReceipt.tokensOut,
        costUsd: notesReceipt.costUsd.toFixed(6),
        latencyMs: notesReceipt.ms,
      });
    for (const s of fix.agentSteps)
      await recordLlmCall(db, {
        runId,
        purpose: "fix",
        step: s.tools.map((t) => t.name).join(",") || "answer",
        model: s.model,
        tokensIn: s.tokensIn,
        tokensCached: s.tokensCached,
        tokensOut: s.tokensOut,
        costUsd: s.costUsd.toFixed(6),
        latencyMs: s.ms,
      });
    if (fix.review)
      await recordLlmCall(db, {
        runId,
        purpose: "review",
        step: "review",
        model: fix.review.model,
        tokensIn: fix.review.tokensIn,
        tokensOut: fix.review.tokensOut,
        costUsd: fix.review.costUsd.toFixed(6),
        latencyMs: fix.review.ms,
      });
    for (const [phase, side] of [
      ["baseline", fix.baseline],
      ["after", fix.after],
    ] as const) {
      await recordSandboxExec(db, {
        runId,
        backend: backend.name,
        phase: phase === "baseline" ? "install_baseline" : "install_after",
        command: "install",
        exitCode: side.install.exitCode,
        durationMs: side.install.ms,
        stdoutTail: side.install.output.slice(-4000),
      });
      for (const c of side.checks)
        await recordSandboxExec(db, {
          runId,
          backend: backend.name,
          phase,
          command: c.argv.join(" "),
          exitCode: c.exitCode,
          timedOut: c.timedOut,
          durationMs: c.ms,
          stdoutTail: c.output.slice(-4000),
        });
    }

    const prMode = fix.evidence.prMode;
    const models = [...new Set([notesReceipt?.model, ...fix.attempts.map((a) => a.model)].filter(Boolean))];
    const runFields = {
      evidenceKind: fix.evidence.kind,
      prMode,
      verification: { baseline: fix.baseline.checks, after: fix.after.checks, reasons: fix.evidence.reasons },
      testCounts: { baseline: fix.evidence.baseline, after: fix.evidence.after },
      egressDenied: fix.after.deniedHosts,
      diff: fix.files.map((f) => f.patch).join("\n"),
      modelsUsed: models.map((m) => ({ id: m, name: modelName(m ?? "") })),
      costUsd: (fix.costUsd + (notesReceipt?.costUsd ?? 0)).toFixed(6),
      attempt: Math.max(1, fix.attempts.length),
    };

    if (outcome.fallback && !dry) {
      const fallbackKey = `${groupKey.split("/").slice(0, -1).join("/")}/${outcome.fallback.version}`;
      const { run: next, created } = await claimRun(db, {
        repoId: repo.id,
        groupKey: fallbackKey,
        lineageKey: run.lineageKey ?? lineageKey(groupKey),
        kind: "fix",
        status: "queued",
        fromVersion: run.fromVersion,
        targetVersion: outcome.fallback.version,
        baseSha: run.baseSha,
        fallbackMajors: run.fallbackMajors + 1,
        idempotencyKey: `fix:${repo.id}:${fallbackKey}:${run.baseSha}`,
      });
      if (created) {
        await appendEvent(db, next.id, "fallback", "from", {
          version: run.targetVersion,
          reason: outcome.fallback.reason,
          runId,
        });
        await ctx.enqueueFix(next.id, repo.id);
      }
      await updateRun(db, runId, {
        ...runFields,
        status: "cancelled",
        step: `fell back to ${outcome.fallback.version}`,
        finishedAt: new Date(),
      });
      await event("fallback", "queued", {
        to: outcome.fallback.version,
        runId: next.id,
        reason: outcome.fallback.reason,
      });
      return { fellBack: outcome.fallback.version };
    }
    if (dry) {
      // The PR Teire would open, kept on the run for the report page; nothing is written to GitHub.
      await updateRun(db, runId, {
        ...runFields,
        status: prMode === "issue" ? "failed" : "succeeded",
        step: prMode === "issue" ? "needs a human" : "dry run complete",
        finishedAt: new Date(),
      });
      await event("pr", "dry-run", {
        title: composed.title,
        body: composed.body,
        mode: prMode,
        labels: outcome.labels,
        evidence: fix.evidence.kind,
      });
      return { dryRun: prMode };
    }
    if (!installation) throw new Error(`run ${runId}: no installation`);

    if (prMode === "issue") {
      // No usable result: a "needs a human" issue with the evidence and the best diff.
      const existing = await getArtifact(db, repo.id, "issue", groupKey);
      const body = `${composed.body}\n\n<sub>Teire stopped: ${fix.evidence.reasons.join("; ")}</sub>`;
      const issue = existing?.number
        ? (
            await installation.octokit.rest.issues.update({
              owner,
              repo: name,
              issue_number: existing.number,
              body,
            })
          ).data
        : (
            await installation.octokit.rest.issues.create({
              owner,
              repo: name,
              title: `Teire needs a human: ${composed.title.toLowerCase()}`,
              body,
              labels: ["teire"],
            })
          ).data;
      await upsertArtifact(db, {
        repoId: repo.id,
        kind: "issue",
        changeKey: groupKey,
        number: issue.number,
        state: "open",
        url: issue.html_url,
        runId,
      });
      await updateRun(db, runId, {
        ...runFields,
        status: "failed",
        step: "needs a human",
        finishedAt: new Date(),
      });
      await event("pr", "issue", { url: issue.html_url, evidence: fix.evidence.kind });
      // The Dashboard issue links "Needs a human" issues, and this group no longer offers "Fix now".
      await syncDashboard(ctx, repo.id).catch(() => undefined);
      return { issue: issue.html_url };
    }

    const branch = branchFor(groupKey);
    // The lock and any manifest the package manager rewrote are among the run's files already.
    // Bytes, symlinks and executable bits as the run left them (D-50).
    const files = fix.files.map((f) => ({
      path: f.path,
      content: f.after,
      ...(f.encoding ? { encoding: f.encoding } : {}),
      ...(f.mode ? { mode: f.mode } : {}),
    }));
    const commit = await commitToBranch({
      octokit: installation.octokit,
      owner,
      repo: name,
      branch,
      baseSha: run.baseSha,
      botLogin: gh.botLogin,
      headline: `${config?.pullRequests?.commitMessage?.prefix ?? ""}${composed.title}`,
      body: `${fix.evidence.kind === "verified" ? "Verified" : "Draft"}: ${fix.evidence.reasons.join("; ")}`,
      files,
    });
    const pr = await openOrUpdatePullRequest({
      octokit: installation.octokit,
      owner,
      repo: name,
      branch,
      base: config?.pullRequests?.targetBranch || repo.defaultBranch,
      title: composed.title,
      body: composed.body,
      draft: prMode === "draft",
      labels: [
        "teire",
        ...outcome.labels,
        // A draft says why in its label too: needs-live-access, typecheck-only, …
        ...(prMode === "draft" ? [fix.evidence.kind.replace(/_/g, "-")] : []),
        ...(config?.pullRequests?.labels ?? []),
      ],
    });
    await publishCheckRun({
      octokit: installation.octokit,
      owner,
      repo: name,
      headSha: commit.oid,
      conclusion: fix.evidence.kind === "verified" ? "success" : "neutral",
      title: `${fix.evidence.kind.replace(/_/g, " ")}: ${outcome.checkTitle}`,
      summary: fix.evidence.reasons.join("; "),
      ...(ctx.webUrl ? { detailsUrl: `${ctx.webUrl}/runs/${runId}` } : {}),
      sites: outcome.sites,
    }).catch((error) => event("pr", "check-run-failed", { error: String(error) }));
    const lineage = run.lineageKey ?? lineageKey(groupKey);
    await upsertArtifact(db, {
      repoId: repo.id,
      kind: "pr",
      changeKey: groupKey,
      lineageKey: lineage,
      number: pr.number,
      branch,
      headSha: commit.oid,
      state: "open",
      url: pr.url,
      runId,
    });
    // A newer target in the same lineage supersedes the open PR for the older one (D111): it closes
    // with a link here, so one PR per package stays open.
    for (const old of await openArtifacts(db, repo.id)) {
      if (old.kind !== "pr" || old.lineageKey !== lineage || old.changeKey === groupKey || !old.number)
        continue;
      try {
        await installation.octokit.rest.issues.createComment({
          owner,
          repo: name,
          issue_number: old.number,
          body: `Superseded by #${pr.number}, which moves to a newer version (\`${groupKey.split("/").at(-1)}\`).`,
        });
        await installation.octokit.rest.pulls.update({
          owner,
          repo: name,
          pull_number: old.number,
          state: "closed",
        });
        await upsertArtifact(db, { ...old, state: "closed" });
        await event("pr", "superseded", { number: old.number, by: pr.number });
      } catch (error) {
        await event("pr", "supersede-failed", { number: old.number, error: String(error) });
      }
    }
    // Named stops in this lineage (earlier runs the updater refused) are settled by this PR.
    for (const stop of (await openArtifacts(db, repo.id)).filter(
      (a) =>
        a.kind === "issue" && a.state === "open" && a.number && a.changeKey.startsWith(`stop/${lineage}@`),
    ))
      try {
        await installation.octokit.rest.issues.createComment({
          owner,
          repo: name,
          issue_number: stop.number as number,
          body: `Resolved: #${pr.number} upgrades to \`${groupKey.split("/").at(-1)}\`.`,
        });
        await installation.octokit.rest.issues.update({
          owner,
          repo: name,
          issue_number: stop.number as number,
          state: "closed",
          state_reason: "completed",
        });
        await upsertArtifact(db, { ...stop, state: "closed" });
      } catch (error) {
        await event("pr", "stop-close-failed", { number: stop.number, error: String(error) });
      }
    await updateRun(db, runId, {
      ...runFields,
      status: "succeeded",
      step: "done",
      headSha: commit.oid,
      finishedAt: new Date(),
    });
    await event("pr", pr.created ? "opened" : "updated", {
      url: pr.url,
      number: pr.number,
      draft: prMode === "draft",
    });
    await syncDashboard(ctx, repo.id).catch((error) =>
      event("dashboard", "failed", { error: String(error) }),
    );
    return { pr: pr.url };
  } catch (error) {
    if (error instanceof CreditsExhaustedError) {
      // Not this run's fault: it waits, and every other run waits, until credits are back.
      await markCreditsExhausted(db, error.message);
      await updateRun(db, runId, {
        status: "queued",
        step: "waiting for Token Factory credits",
        error: error.message,
      });
      await event("queue", "deferred", { reason: error.message });
      await ctx.enqueueFix(runId, repo.id, BUDGET_RETRY_SECONDS);
      return { deferred: error.message };
    }
    if (error instanceof ResolverUnavailableError) {
      const tries = (await runEventsOf(db, runId, "resolver")).filter((e) => e.type === "deferred").length;
      if (tries < RESOLVER_RETRIES) {
        await updateRun(db, runId, {
          status: "queued",
          step: "waiting for the dependency-file updater",
          error: error.message,
        });
        await event("resolver", "deferred", { reason: error.message, retry: tries + 1 });
        await ctx.enqueueFix(runId, repo.id, RESOLVER_RETRY_SECONDS);
        return { deferred: error.message };
      }
    }
    if (error instanceof ResolverNothingError) {
      const reason = `dependabot-core's updater: ${error.message}`;
      await updateRun(db, runId, {
        status: "cancelled",
        step: "nothing to change",
        error: reason,
        finishedAt: new Date(),
      });
      await event("resolver", "nothing", { reason });
      return { cancelled: true };
    }
    if (error instanceof ResolverStopError || error instanceof ResolverUnavailableError) {
      const reason =
        error instanceof ResolverStopError
          ? `dependabot-core's updater stopped (${error.type}): ${error.message}`
          : `the dependency-file updater was unavailable ${RESOLVER_RETRIES + 1} times: ${error.message}`;
      await updateRun(db, runId, { status: "failed", error: `stopped: ${reason}`, finishedAt: new Date() });
      await event("resolver", "stopped", { reason });
      if (!dry && installation) await openStopIssue(ctx, installation.octokit, repo, run, groupKey, reason);
      return { stopped: reason };
    }
    const message =
      error instanceof HumanCommitsError
        ? `stopped: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    await updateRun(db, runId, { status: "failed", error: message, finishedAt: new Date() });
    await event("run", "failed", { error: message });
    if (error instanceof HumanCommitsError) {
      // C6: a person pushed to Teire's branch; their commits are never overwritten.
      const open = await getArtifact(db, repo.id, "pr", groupKey);
      if (open?.number && open.state === "open")
        await installation?.octokit.rest.issues
          .createComment({
            owner,
            repo: name,
            issue_number: open.number,
            body: `Teire stopped updating this branch: ${error.message}. Your commits stay; comment \`@teire recreate\` to start over from the current base.`,
          })
          .catch(() => undefined);
    }
    if (!(error instanceof HumanCommitsError)) throw error;
    return { stopped: message };
  } finally {
    clearInterval(heartbeat);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
