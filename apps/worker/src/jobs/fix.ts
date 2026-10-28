import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AFFECTED_RANGES_SEPARATOR, stillAffected } from "@teire/engine/advisories";
import { RunCancelledError, withCancel } from "@teire/engine/cancel";
import { matchesTarget, readTeireConfig, type TeireConfig, updateIgnores } from "@teire/engine/config";
import { RUNS, SCAN } from "@teire/engine/constants";
import { type CallSite, type ChangeV2, type Ecosystem, lineageKey } from "@teire/engine/contract";
import {
  cargoFeatureOverlay,
  type FixRun,
  type Transaction,
  withGradleLocks,
  withToolchainFloors,
} from "@teire/engine/fix";
import {
  branchFor,
  commitToBranch,
  composeHumanIssue,
  forGitHub,
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
  GRADLE_WRAPPER_FILE,
  isDependencyFile,
  jobSettings,
  PACKAGE_MANAGER,
  ResolverUnavailableError,
  readDependabotConfig,
  resolverTransaction,
  type TeireManager,
  updateFor,
  wrapperRaiseOnly,
} from "@teire/engine/resolver";
import { cargoSurfaceDiff, goSurfaceDiff } from "@teire/engine/surface";
import { cancellableBackend, selectBackend, unsupportedToolchain } from "@teire/engine/verify";
import { cachedSurfaceDiff, postgresRegistryCache } from "../caches";
import { markCreditsExhausted, modelWorkBlocked } from "../reliability";
import { resolveForRepo } from "../resolver";
import {
  appendEvent,
  cancelRequest,
  claimRun,
  claimRunLease,
  fixModeOf,
  getArtifact,
  getRepo,
  getRun,
  holdsRun,
  openArtifacts,
  prCounts,
  recordLlmCall,
  recordSandboxExec,
  renewLease,
  runEventsOf,
  setRepo,
  settleRunActions,
  updateHeldRun,
  type updateRun,
  upsertArtifact,
  WORKER_ID,
} from "../store";
import { fixesOffReply, readOrgConfig } from "./commands";
import { syncDashboard } from "./dashboard";
import { pageReader, storedProviderChanges } from "./providers";
import { requesterToken } from "./public";
import type { WorkerContext } from "./scan";

/** A run deferred for credits or the daily budget tries again after this long. */
const BUDGET_RETRY_SECONDS = 30 * 60;
const DEFER_SECONDS = 3600;
/**
 * An unreachable resolver queues the run this many times, 15 minutes doubling (about 16 hours in
 * all, so a deploy window or a host restart never ends a run), then it is a named stop.
 */
const RESOLVER_RETRIES = 6;
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
      affectedVersions: r.applicability.affectedRange?.split(AFFECTED_RANGES_SEPARATOR) ?? [`< ${target}`],
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

/**
 * Which lockfile roots a multi-root PR verified (D94): the sandbox installs and checks the lead root;
 * the others the updater changed are named as not run in the sandbox, and roots under another
 * package manager that this PR leaves alone are named too, so the PR never claims more than ran.
 */
function withRoots(
  body: string,
  lead: string,
  transaction: Transaction | null | undefined,
  matching: Assessment<AssessedProject>[],
  /** Roots the run checked besides the lead (every other project the change touched). */
  checked: string[] = [],
) {
  const changed = new Set(
    (transaction?.readBack ?? [])
      .map(
        (path) =>
          matching.find((m) => m.project.root !== "." && path.startsWith(`${m.project.root}/`))?.project
            .root ?? ".",
      )
      .filter((root) => matching.some((m) => m.project.root === root)),
  );
  const unverified = [...changed].filter((r) => r !== lead && !checked.includes(r));
  const left = [...new Set(matching.map((m) => m.project.root))].filter((r) => r !== lead && !changed.has(r));
  if (!unverified.length && !left.length) return body;
  const name = (r: string) => `\`${r === "." ? "/" : r}\``;
  const lines = [
    `The sandbox installed and checked ${[lead, ...checked.filter((r) => r !== lead)].map(name).join(", ")}.${unverified.length ? ` The same upgrade in ${unverified.map(name).join(", ")} was not run in the sandbox.` : ""}${left.length ? ` ${left.map(name).join(", ")} also declare${left.length === 1 ? "s" : ""} it${transaction ? " under another package manager" : ""}; this pull request doesn't change ${left.length === 1 ? "it" : "them"}.` : ""}`,
  ];
  const at = body.indexOf("\n\n### Why this repo");
  return at < 0
    ? `${body}\n\n${lines.join("\n")}`
    : `${body.slice(0, at)}\n\n${lines.join("\n")}${body.slice(at)}`;
}

/** The updater refused the upgrade, with its typed reason, quoted on the run and in an issue. */
/** This worker no longer holds the run's lease: another worker has it and writes its results. */
export class LeaseLostError extends Error {
  constructor() {
    super("another worker took this run over");
  }
}

class ResolverStopError extends Error {
  constructor(
    readonly type: string,
    message: string,
    /** Who stopped: the updater's event, or Teire's own check before any work (a pinned runtime). */
    readonly by: "updater" | "teire" = "updater",
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

/** Which of several roots leads a run: one whose code breaks before one that is unclear or clean. */
const LEAD_RANK: Record<string, number> = { affected: 3, needs_human: 2, inconclusive: 1, not_affected: 0 };

/**
 * Bundler explains a failure as a chain of "Because …" clauses; the Ruby floor is the only cause when
 * every clause of the chain is about Ruby (review R7). Any other incompatibility keeps the stop.
 */
export function rubyIsTheOnlyCause(message: string) {
  const clauses = message
    .replace(/\s+/g, " ")
    .split(/(?=\b(?:Because|So, because|And because|Thus,)\b)/)
    .map((c) => c.trim())
    .filter((c) => /^(?:Because|So, because|And because|Thus,)/.test(c));
  if (!clauses.length || !clauses.every((c) => /\bRuby\b/.test(c))) return false;
  // A clause can name Ruby and still carry a gem conflict (stage R review, round 2): the chain must
  // end at the running Ruby, and nothing in it may be a gem conflict in any of Bundler's wordings
  // (two constraints on one gem, incompatible or conflicting gems, a forbidden, missing or unknown
  // gem, a requirement derived on a gem rather than on Ruby). Anything unrecognised keeps the stop.
  const text = clauses.join(" ");
  if (!/\bcurrent Ruby version is\b/.test(text)) return false;
  if (/\b(?!Ruby\b)[\w.-]+ is incompatible with\b/.test(text)) return false;
  if (
    /\b(?:conflicts? with|is forbidden|no versions? of|doesn't exist|could not be found|is unknown|requires (?!Ruby\b))/i.test(
      text,
    )
  )
    return false;
  const constraints = new Map<string, Set<string>>();
  for (const m of text.matchAll(/depends on ([\w.-]+) ([<>=~!]+ ?[\w.-]+)/g)) {
    const [, gem = "", req = ""] = m;
    if (gem === "Ruby") continue;
    constraints.set(gem, (constraints.get(gem) ?? new Set()).add(req.replace(/\s+/g, "")));
  }
  return [...constraints.values()].every((reqs) => reqs.size === 1);
}

/** The Ruby a repo pins for a root: `.ruby-version`, else the Gemfile's `ruby "…"`. */
function repoRuby(tree: RepoTree, root: string) {
  const at = (file: string) => tree.read(root === "." ? file : `${root}/${file}`);
  const version = at(".ruby-version")
    ?.trim()
    .replace(/^ruby-/, "");
  if (version && /^\d+\.\d+(\.\d+)?$/.test(version)) return version;
  return /^\s*ruby\s+["']([\d.]+)["']/m.exec(at("Gemfile") ?? "")?.[1] ?? null;
}

/**
 * Whether the repository is private right now, from GitHub (review R1): with the installation's
 * client for installed repos, else as the person who asked (a dry run). A repository GitHub hides
 * from an anonymous read is not public. Null when GitHub didn't answer.
 */
export async function githubRepoNow(
  owner: string,
  name: string,
  octokit: Awaited<ReturnType<WorkerContext["gh"]["installation"]>>["octokit"] | null,
  token: string | null,
): Promise<{ isPrivate: boolean | null; sizeKb: number | null }> {
  const unknown = { isPrivate: null, sizeKb: null };
  try {
    if (octokit) {
      const { data } = await octokit.rest.repos.get({ owner, repo: name });
      return { isPrivate: data.private, sizeKb: data.size ?? null };
    }
    const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "teire",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return { isPrivate: true, sizeKb: null };
    if (!res.ok) return unknown;
    const data = (await res.json()) as { private?: boolean; size?: number };
    return { isPrivate: data.private ?? null, sizeKb: data.size ?? null };
  } catch {
    return unknown;
  }
}

/** How Teire raises a transitive package past its parents' ranges, per package manager (S15.7). */
function transitiveRung(ecosystem: Ecosystem, manager: string): string | null {
  if (ecosystem === "npm") return "an override (npm and pnpm `overrides`, Yarn and Bun `resolutions`)";
  if (ecosystem === "go")
    return "a `go get` requirement: Go builds with the highest version any module requires";
  if (ecosystem === "pypi" && manager === "uv") return "uv's `override-dependencies`";
  if (ecosystem === "maven" && manager === "gradle") return "a Gradle dependency constraint";
  if (ecosystem === "maven") return "a `<dependencyManagement>` pin in the root POM";
  return null;
}

/** Why a package manager has no such rung, quoted in the stop. */
const NO_TRANSITIVE_RUNG: Partial<Record<Ecosystem, string>> = {
  cargo: "Cargo can't override a crates.io version: `[patch]` must point to another source",
  rubygems: "Bundler has no override: every gem that depends on it must allow the fixed version",
  pypi: "Only uv can override a dependency's dependencies (`override-dependencies`); this package manager can't",
};

/**
 * The dependency-file change from dependabot-core's updater (S15.1, D92), one job across every
 * lockfile root the same Dependabot package manager covers (D94), for the ecosystems in
 * TEIRE_RESOLVER_ECOSYSTEMS. Teire's own transaction stays where D104 keeps it: Go majors (a new
 * module path), renamed or aliased packages, `pylock.toml`, lockfiles the updater can't read, and
 * npm-family transitive overrides. Every other answer is final: a stop or an unexpected file is a
 * named stop, nothing is cancelled with the reason, an outage queues; below the target becomes the
 * target (D103), and a security fix above the lowest published one becomes the floor.
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
  // The transitive ladder (S15.7): when the updater can't move a transitive package within its
  // parents' ranges, Teire's own rung raises it where the package manager has a way (D104), read
  // back from the new lockfile; where it has none, the stop says so.
  const transitiveStop =
    r.kind === "stop" &&
    r.type === "security_update_not_possible" &&
    assessment.purpose === "security" &&
    !assessment.instance.direct;
  const rung = transitiveStop ? transitiveRung(ecosystem, assessment.project.manager) : null;
  if (transitiveStop && rung) {
    common.onEvent?.({
      step: "transaction",
      detail: `dependabot-core's updater can't move ${packageName} within its parents' ranges (${r.message}); Teire raises it with ${rung}`,
    });
    return null;
  }
  // Dependabot resolves a gem against the lowest Ruby its gemspec allows; a repo that pins a newer
  // Ruby (`.ruby-version`, the Gemfile's `ruby`) resolves with that one, so Teire's own transaction
  // (Bundler in the sandbox, on the repo's Ruby) decides instead (D104).
  if (r.kind === "stop" && r.type === "dependency_file_not_resolvable" && ecosystem === "rubygems") {
    const assumed = /current Ruby version is = ([\d.]+)/.exec(r.message)?.[1];
    const pinned = repoRuby(tree, assessment.project.root);
    if (assumed && pinned && pinned !== assumed && rubyIsTheOnlyCause(r.message)) {
      common.onEvent?.({
        step: "transaction",
        detail: `dependabot-core's updater resolved with Ruby ${assumed}, the floor of the gemspec's required_ruby_version, and stopped (${r.message.split("\n")[0]}); this repo runs Ruby ${pinned}, so Bundler resolves with it in the sandbox`,
      });
      return null;
    }
  }
  if (r.kind === "stop")
    throw new ResolverStopError(
      r.type,
      transitiveStop && NO_TRANSITIVE_RUNG[ecosystem]
        ? `${r.message}. ${NO_TRANSITIVE_RUNG[ecosystem]}`
        : r.message,
    );
  if (r.kind === "close") throw new ResolverNothingError(`nothing to change: ${r.reason}`);
  if (r.kind === "nothing")
    throw new ResolverNothingError(
      [`no update to ${target} (the updater's log has the details)`, ...r.warnings].join("; "),
    );
  // The updater runs repository code, so its events are untrusted: only dependency files come back.
  const scope = { ecosystem, moved: [packageName, ...r.moved.map((m) => m.name)] };
  const unexpected = r.files.filter((f) => !isDependencyFile(f.path, scope)).map((f) => f.path);
  if (unexpected.length)
    throw new ResolverStopError(
      "unexpected_file",
      `the updater's change includes files that aren't dependency files (${unexpected.slice(0, 5).join(", ")}); Teire doesn't commit them`,
    );
  // The wrapper's jar and scripts come back only with a Gradle version raise in its properties.
  if (r.files.some((f) => GRADLE_WRAPPER_FILE.test(f.path))) {
    const props = r.files.find((f) => f.path.endsWith("gradle/wrapper/gradle-wrapper.properties"));
    if (!props || !wrapperRaiseOnly(tree.read(props.path) ?? null, props.content))
      throw new ResolverStopError(
        "unexpected_file",
        "the updater changed the Gradle wrapper beyond its distribution version; Teire doesn't commit that",
      );
  }
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
      // The final check before a security PR claims a fix: the version must be outside every range.
      const still = assessment.records.filter(
        (a) => a.kind === "security-advisory" && stillAffected(a, r.leadVersion as string, ecosystem),
      );
      if (still.length)
        throw new ResolverStopError(
          "fix_not_resolvable",
          `the lowest ${packageName} the updater can resolve here is ${r.leadVersion}, which ${still.map((a) => a.id.split("/").at(-1)).join(", ")} still affect`,
        );
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
  // The toolchain the target needs (Java, requires-python, rust-version) is raised in the same
  // change, on the lead root, as Teire's own transactions do (S15.10, review R3).
  const floors = await withToolchainFloors({
    ecosystem,
    tree,
    project: assessment.project,
    name: packageName,
    target,
    edits: tx.manifest,
    options: common.options,
  });
  for (const note of floors.notes) common.onEvent?.({ step: "transaction", detail: note });
  const raised: Transaction = {
    ...tx,
    manifest: floors.edits,
    readBack: [...new Set([...tx.readBack, ...floors.edits.map((e) => e.path)])],
  };
  // Gradle locks are re-locked by Teire for this coordinate only, in every root the job covered.
  return matching
    .filter((m) => m.project.manager === "gradle")
    .reduce((t, m) => withGradleLocks(t, m.project as JvmProject, packageName, target), raised);
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
    ignoreUpdates: updateIgnores(config.ignore),
    onlyPackage: packageName,
    ...(cap ? { targetMax: { name: packageName, version: cap.version, reason: cap.reason } } : {}),
    ...(cap?.floor ? { targetFloor: { name: packageName, version: cap.version } } : {}),
    ...(run.fallbackMajors ? { fallbackMajors: run.fallbackMajors } : {}),
    ...(token ? { githubToken: token } : {}),
    surfaceDiff: (n: string, f: string, t: string) =>
      cachedSurfaceDiff(ctx.db, ecosystem, n, f, t, { cache }),
  };
  const assess = async (
    extra: {
      fallbackMajors?: number;
      targetMax?: { name: string; version: string; reason: string };
      targetFloor?: { name: string; version: string };
    } = {},
  ) => {
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
  // Every lockfile root that declares the package at this target. The most urgent leads; the run
  // names the others (one PR per package per repo, D94; the resolver edits them all from S15).
  const matchingIn = (list: Assessment<AssessedProject>[]) => {
    const found = list
      .filter((a) => a.decision?.kind === "upgrade" && a.decision.to === run.targetVersion)
      // `@teire ignore` and teire.yml `ignore` apply to the run as they do to the scan (C8).
      .filter(
        (a) => !a.findings.length || a.findings.some((f) => !config.ignore.some((t) => matchesTarget(t, f))),
      );
    // Ties go to the root the change breaks, counted over all its assessments for this target (a
    // security assessment locates nothing; the upgrade's API diff does): that code is what the run
    // fixes and verifies.
    const sites = new Map<string, number>();
    for (const a of found)
      sites.set(
        a.project.root,
        (sites.get(a.project.root) ?? 0) +
          (a.summary?.breaking.reduce((n, f) => n + Math.max(1, f.callSites.length), 0) ?? 0),
      );
    return found.sort(
      (a, b) =>
        (a.priority ?? 9) - (b.priority ?? 9) ||
        (sites.get(b.project.root) ?? 0) - (sites.get(a.project.root) ?? 0) ||
        (LEAD_RANK[b.summary?.verdict ?? ""] ?? 0) - (LEAD_RANK[a.summary?.verdict ?? ""] ?? 0),
    );
  };
  let matching = matchingIn(await assess());
  // A refresh (rebase, CI repair, recreate) of a PR whose target moved from the registry's answer
  // (a D103 cap, a security floor, a D71 fallback) keeps that PR's version.
  if (!matching.length && !cap)
    matching = matchingIn(
      await assess({
        targetMax: {
          name: packageName,
          version: run.targetVersion,
          reason: "the version this pull request already moves to",
        },
        targetFloor: { name: packageName, version: run.targetVersion },
      }),
    );
  const assessment = matching[0];
  if (!assessment) return null;
  // A runtime the repo pins hard and the sandbox can't fall forward from is a named stop (S14.2).
  const pinned = unsupportedToolchain(tree, assessment.project.root, ecosystem);
  if (pinned)
    throw new ResolverStopError(
      "tool_version_not_supported",
      `${pinned.file} asks for ${pinned.asks}, which the sandbox can't run (it has ${pinned.sandbox})`,
      "teire",
    );
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
    // The PR says why its target moved (D103 cap, security floor): compose reads it from options.
    ...(cap
      ? {
          options: {
            ...common.options,
            targetMax: { name: packageName, version: cap.version, reason: cap.reason },
          },
        }
      : {}),
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
    pr: {
      ...result.pr,
      body: withRoots(
        result.pr.body,
        assessment.project.root,
        transaction,
        matching,
        (result.run.others ?? []).map((o) => o.root),
      ),
    },
    notesReceipt: result.notesReceipt,
    labels: [
      ecosystem,
      assessment.purpose === "security"
        ? "security"
        : assessment.decision?.kind === "upgrade" && assessment.decision.isMajor
          ? "major"
          : "upgrade",
    ],
    checkTitle: `${packageName} ${run.fromVersion ? `${run.fromVersion} → ` : "→ "}${run.targetVersion}`,
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

/** Evidence reasons as GitHub shows them: each redacted and shortened (review R18). */
export const saidOnGitHub = (reasons: string[]) => reasons.map((r) => forGitHub(r, 400)).join("; ");

/** A stop issue quotes more of the updater than a progress line does. */
const STOP_REASON_CHARS = 1500;

/**
 * The command's "Started" reply, edited in place with how the run ended (S15.8, R-P5): the PR it
 * opened, the issue for a person, the fallback, nothing to change, waiting, or the stop's reason.
 */
async function updateProgress(
  ctx: WorkerContext,
  runId: string,
  octokit: Awaited<ReturnType<WorkerContext["gh"]["installation"]>>["octokit"] | undefined,
  line: string,
) {
  if (!octokit) return;
  const comment = (await runEventsOf(ctx.db, runId, "progress")).find((e) => e.type === "comment")?.payload as
    | { owner: string; repo: string; commentId: number; started: string }
    | undefined;
  if (!comment) return;
  await octokit.rest.issues
    .updateComment({
      owner: comment.owner,
      repo: comment.repo,
      comment_id: comment.commentId,
      body: `${comment.started}\n\n${line}`,
    })
    .catch(() => undefined);
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
  // Another worker is on this run now: it finishes it. Its own job brings the run back if that
  // worker dies (the boot sweep and the reaper), so nothing is queued here; a deferral queued under
  // the repository's singleton key could be dropped silently (stage R review).
  if (!(await claimRunLease(db, runId, RUNS.leaseMs))) return { skipped: "another worker holds this run" };
  // Every write about this run is fenced by its lease (stage R round 2): once another worker holds it,
  // this one writes nothing more to the run or to GitHub. Run updates check the holder in the same
  // statement; each GitHub write renews the lease first.
  let leaseLost = false;
  const lost = () => {
    leaseLost = true;
    return new LeaseLostError();
  };
  const update = async (fields: Parameters<typeof updateRun>[2]) => {
    if (leaseLost) throw lost();
    if (await updateHeldRun(db, runId, fields)) return;
    // Still this worker's, but cancelled meanwhile (fixes turned Off while it was queued): it stops as
    // a cancel, not as a lost lease (U1 review).
    const now = await getRun(db, runId);
    if (now?.workerId === WORKER_ID && now.status === "cancelled") {
      abort.abort();
      throw new RunCancelledError();
    }
    throw lost();
  };
  const holdLease = async () => {
    if (leaseLost || !(await renewLease(db, runId))) throw lost();
  };
  // Cancel (U1, "Cancel is honest"): a person's request (`runs.cancel_requested_at`) is looked for
  // every few seconds and fires one controller: model calls and the updater job stop, sandboxes are
  // closed, and nothing is published after it.
  const abort = new AbortController();
  let cancelledBy: string | null = null;
  let lastStep = run.step ?? "assess";
  // The last thing the run said it was doing ("after: test exit 0 in 2214 ms"), for "stopping".
  let lastDetail: string | null = null;
  // Once the branch is pushed the run has published: a cancel after that is too late, never a
  // "cancelled" run with its PR standing on GitHub (U1 review).
  let published = false;
  // Why the run stopped when no person asked: fixes turned Off before it published.
  let stopReason: string | null = null;
  const beforePublish = async () => {
    if (!published) {
      if (abort.signal.aborted) throw new RunCancelledError();
      // Off since the run started: nothing is published (D125; the U1 review's race with a run
      // claimed just before the mode changed).
      // The repository as it is now: a fix mode set during the run counts (U1 review).
      const fresh = dry || !repo ? null : await getRepo(db, repo.id);
      const now = fresh ? await fixModeOf(db, fresh) : null;
      if (now?.mode === "off") {
        stopReason = fixesOffReply(now);
        abort.abort();
        throw new RunCancelledError();
      }
    }
    await holdLease();
    // A cancel that landed while the lease renewed still stops it: the caller marks the run published
    // right after this returns, with nothing awaited in between (U2 review).
    if (!published && abort.signal.aborted) throw new RunCancelledError();
  };
  if (run.status === "failed" || run.status === "running") {
    await update({ status: "queued", attempt: run.attempt + 1, error: null });
    // The run page marks where the earlier attempt ended, so its repeated steps read as a restart.
    await appendEvent(
      db,
      runId,
      "restart",
      "attempt",
      {
        detail: `attempt ${run.attempt + 1}: the worker running it stopped, so it starts over from the beginning`,
      },
      true,
    );
  }
  const repo = await getRepo(db, run.repoId);
  // A dry run (C9) works on any public repo: no installation, no GitHub writes, no PR caps.
  const dry = run.kind === "dry_run";
  if (!repo || (!dry && !repo.installationId) || !run.groupKey || !run.targetVersion || !run.baseSha) {
    // Recorded on the run, so it shows as failed instead of waiting in the queue forever.
    await update({
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
    await update({ status: "cancelled", step: "repository paused", finishedAt: new Date() });
    await appendEvent(db, runId, "queue", "cancelled", {
      reason: "the repository is paused; resume it to fix",
    });
    await settleRunActions(db, runId, ["fix", "rebase", "refresh", "recreate", "retry-run"], {
      status: "refused",
      result: "The repository is paused; resume it first",
    });
    return { cancelled: "paused" };
  }
  // Fix mode (D118, D125): Off cancels queued runs with the mode and where it was set; scans and the
  // Dashboard issue go on. Ask first lets runs already queued finish (nothing new starts on its own).
  const mode = dry ? null : await fixModeOf(db, repo);
  if (mode?.mode === "off") {
    await update({ status: "cancelled", step: "fixes off", finishedAt: new Date() });
    await appendEvent(db, runId, "queue", "cancelled", {
      reason: fixesOffReply(mode),
    });
    await settleRunActions(db, runId, ["fix", "rebase", "refresh", "recreate", "retry-run"], {
      status: "refused",
      result: fixesOffReply(mode),
    });
    return { cancelled: "fixes off" };
  }
  const installation = repo.installationId && !dry ? await gh.installation(repo.installationId) : null;
  const event = (step: string, type: string, payload: object) => {
    if (leaseLost) throw new LeaseLostError();
    return appendEvent(db, runId, step, type, payload, true);
  };
  // The run's progress comment on GitHub, edited in place; only while this worker holds the run.
  const progress = async (text: string) => {
    await holdLease();
    await updateProgress(ctx, runId, installation?.octokit, text);
  };
  // D107 (review R1): the backend follows the repository's visibility now, read from GitHub just
  // before it is chosen, never the stored flag; an answer GitHub didn't give counts as private. A
  // dry run is for public repositories only, so one whose repository went private is refused.
  const requester = dry ? ((await requesterToken(db, run.requestedBy)) ?? null) : null;
  const now = await githubRepoNow(owner, name, installation?.octokit ?? null, requester);
  const privateNow = now.isPrivate;
  if (privateNow !== null && privateNow !== repo.isPrivate)
    await setRepo(db, repo.id, { isPrivate: privateNow });
  if (dry && privateNow !== false) {
    const reason =
      privateNow === null
        ? "GitHub didn't say whether the repository is still public; dry runs are for public repositories only"
        : "the repository is no longer public; dry runs are for public repositories only";
    await update({
      status: "failed",
      step: "not public",
      error: reason,
      finishedAt: new Date(),
    });
    await event("queue", "refused", { reason });
    return { refused: "not public" };
  }
  // The same size rule as public scans (review R17): a repository this large isn't sent to a sandbox.
  if (now.sizeKb !== null && now.sizeKb > SCAN.maxRepoKb) {
    const reason = `${repo.fullName} is ${Math.round(now.sizeKb / 1024)} MB; Teire verifies repositories up to ${SCAN.maxRepoKb / 1024} MB`;
    await update({
      status: "failed",
      step: "too large",
      error: reason,
      finishedAt: new Date(),
    });
    await event("queue", "refused", { reason });
    return { refused: "too large" };
  }

  // Noise controls before any work (D70): per-repo open PRs and new PRs per hour. They limit new
  // pull requests, as Dependabot's open-pull-requests-limit does: a run that refreshes an open PR on
  // its own branch (rebase, recreate, a base move) is never held back. A newer target opens a new
  // branch and PR, so it counts (review R5).
  const config = (repo.config as ReturnType<typeof readTeireConfig> | null) ?? null;
  const limits = config?.pullRequests ?? { limit: 5, perHour: 2 };
  const openNow = dry ? [] : await openArtifacts(db, repo.id);
  const refresh = openNow.some((a) => a.kind === "pr" && a.changeKey === groupKey);
  // A newer version in a lineage replaces that lineage's open PR one for one (it closes when the new
  // one opens), so the PR it supersedes doesn't count against the open limit (stage R review).
  const supersedes = openNow.some(
    (a) => a.kind === "pr" && a.changeKey !== groupKey && !!run.lineageKey && a.lineageKey === run.lineageKey,
  );
  const counted = dry || refresh ? { open: 0, lastHour: 0 } : await prCounts(db, repo.id);
  const counts = { ...counted, open: Math.max(0, counted.open - (supersedes ? 1 : 0)) };
  if (counts.open >= limits.limit || counts.lastHour >= limits.perHour) {
    await update({ status: "queued", step: "waiting for the PR limit", workerId: null });
    await event("queue", "deferred", { open: counts.open, lastHour: counts.lastHour, limits });
    await settleRunActions(db, runId, ["fix", "rebase", "refresh", "recreate", "retry-run"], {
      status: "started",
      result: `Waiting for the PR limit (${counts.open} of ${limits.limit} open, ${counts.lastHour} of ${limits.perHour} this hour)`,
    });
    await ctx.enqueueFix(runId, repo.id, DEFER_SECONDS);
    return { deferred: true };
  }

  // Money and the model service decide whether model work may start (S10).
  const blocked = await modelWorkBlocked(db);
  if (blocked) {
    await update({ status: "queued", step: "waiting for the model budget", workerId: null });
    await event("queue", "deferred", { reason: blocked });
    await settleRunActions(db, runId, ["fix", "rebase", "refresh", "recreate", "retry-run"], {
      status: "started",
      result: `Waiting: ${blocked}`,
    });
    await ctx.enqueueFix(runId, repo.id, BUDGET_RETRY_SECONDS);
    return { deferred: blocked };
  }

  // A run resumed after a deferral (credits, the updater) starts clean: the old reason is history.
  await update({ status: "running", step: "assess", startedAt: new Date(), error: null });
  // A person's Fix now, Rebase, Recreate or Retry is done once its run has started.
  await settleRunActions(db, runId, ["fix", "rebase", "refresh", "recreate", "retry-run"], {
    status: "done",
    result: "Run started",
  });
  // A heartbeat while the run works, so the reaper can tell a long sandbox step from a dead worker.
  // It renews only this worker's lease: if another worker took the run (this one was paused past the
  // lease), the run stops before writing anything to GitHub (stage R review).
  const watchCancel = setInterval(
    () =>
      void cancelRequest(db, runId)
        .then((c) => {
          if (c && !abort.signal.aborted && !published) {
            cancelledBy = c.by;
            abort.abort();
            // The run page says it is stopping and where (plan "Cancel is honest").
            void appendEvent(db, runId, "run", "stopping", {
              by: c.by,
              during: lastStep,
              doing: lastDetail,
            }).catch(() => undefined);
          }
        })
        .catch(() => undefined),
    RUNS.cancelPollMs,
  );
  const heartbeat = setInterval(
    () =>
      void renewLease(db, runId)
        .then((held) => {
          // Another worker has the run: this one stops its work now, not at its next write (U1 review).
          if (!held && !leaseLost) {
            leaseLost = true;
            abort.abort();
          }
        })
        .catch(() => undefined),
    RUNS.heartbeatEveryMs,
  );
  await event("assess", "started", { group: groupKey, from: run.fromVersion, target: run.targetVersion });
  // A dry run reads GitHub as the person who asked (their own rate limit), anonymously without it.
  const token = installation ? await installation.token() : (requester ?? undefined);
  let dir: string | null = null;
  try {
    const baseSha = run.baseSha;
    const checkout = await withCancel(abort.signal, () =>
      fetchRepoTarball(owner, name, baseSha, token ? { token } : {}),
    );
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
    // D107: public repositories and dry runs verify on Token Factory Sandboxes; private ones on Cloudflare.
    // Read again right before every upload to Token Factory (review R1, round 2): a repository made
    // private during the run stops reaching it. Uploads that ask at the same moment share one read;
    // no answer is reused once it has returned. Anything but a confirmed "public" is private.
    let reading: Promise<boolean> | null = null;
    const stillPublic = () => {
      reading ??= githubRepoNow(owner, name, installation?.octokit ?? null, requester)
        .then(async (r) => {
          // The repository row follows too, so its run pages stop being public (review round 2).
          if (r.isPrivate === true && !repo.isPrivate) await setRepo(db, repo.id, { isPrivate: true });
          return r.isPrivate === false;
        })
        .finally(() => {
          reading = null;
        });
      return reading;
    };
    const selected = await selectBackend(process.env, {
      isPrivate: dry ? false : (privateNow ?? true),
      stillPublic,
    });
    const { note } = selected;
    const backend = cancellableBackend(selected.backend, abort.signal);
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
      // Fire-and-forget, so it never throws: a lost lease is noted and the next fenced write stops the run.
      onEvent: (e: { step: string }) => {
        if (leaseLost) return;
        lastStep = e.step;
        const said = (e as { detail?: unknown }).detail;
        if (typeof said === "string") lastDetail = said.slice(0, 160);
        void appendEvent(db, runId, e.step, "log", e, true).catch(() => undefined);
        void updateHeldRun(db, runId, { step: e.step })
          .then((held) => {
            if (!held) leaseLost = true;
          })
          .catch(() => undefined);
      },
    };
    await update({ step: "fix", backend: backend.name });
    // A fallback run (D71) carries the newer major it replaces, written when it was queued.
    const fallbackFrom = (await runEventsOf(db, runId, "fallback")).find((e) => e.type === "from")?.payload as
      | { version: string; reason: string }
      | undefined;
    const targetVersion = run.targetVersion;
    const outcome = await withCancel(abort.signal, async () =>
      isApi
        ? await apiOutcome(ctx, { groupKey }, checkout.dir, tree, runConfig, common)
        : await packageOutcome(
            ctx,
            { id: repo.id, installationId: repo.installationId, isPrivate: repo.isPrivate },
            {
              groupKey,
              targetVersion,
              fromVersion: run.fromVersion,
              fallbackMajors: run.fallbackMajors,
              ...(fallbackFrom ? { fallbackFrom } : {}),
            },
            checkout.dir,
            tree,
            runConfig,
            token,
            common,
          ),
    );
    if (abort.signal.aborted) throw new RunCancelledError();
    if (outcome?.groupKey && outcome.groupKey !== groupKey) {
      await event("transaction", "target-moved", { from: run.targetVersion, to: outcome.targetVersion });
      await update({
        groupKey: outcome.groupKey,
        targetVersion: outcome.targetVersion ?? run.targetVersion,
        lineageKey: lineageKey(outcome.groupKey),
      });
      groupKey = outcome.groupKey;
    }
    if (!outcome) {
      await update({ status: "cancelled", step: "no longer applies", finishedAt: new Date() });
      await event("assess", "cancelled", { reason: "the change no longer applies to this repo" });
      await progress("Nothing to do: the change no longer applies at this commit.");
      return { cancelled: true };
    }
    const { fix, pr: composed, notesReceipt } = outcome;

    // Receipts: every model call and every sandbox command, written only by the worker that holds
    // the run, so a run never shows another worker's calls and costs (review round 2). They go in
    // one transaction that first locks the run as this worker's: a worker taking the run over waits
    // for it, and a worker that lost it writes nothing (U1 review).
    await holdLease();
    await db.transaction(async (tx) => {
      if (!(await holdsRun(tx, runId))) throw lost();
      if (notesReceipt)
        await recordLlmCall(tx, {
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
        await recordLlmCall(tx, {
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
        await recordLlmCall(tx, {
          runId,
          purpose: "review",
          step: "review",
          model: fix.review.model,
          tokensIn: fix.review.tokensIn,
          tokensOut: fix.review.tokensOut,
          costUsd: fix.review.costUsd.toFixed(6),
          latencyMs: fix.review.ms,
        });
      if (fix.triage)
        await recordLlmCall(tx, {
          runId,
          purpose: "review",
          step: "install-triage",
          model: fix.triage.model,
          tokensIn: fix.triage.tokensIn,
          tokensOut: fix.triage.tokensOut,
          costUsd: fix.triage.costUsd.toFixed(6),
          latencyMs: fix.triage.ms,
        });
      for (const [phase, side] of [
        ["baseline", fix.baseline],
        ["after", fix.after],
      ] as const) {
        await recordSandboxExec(tx, {
          runId,
          backend: backend.name,
          phase: phase === "baseline" ? "install_baseline" : "install_after",
          command: "install",
          exitCode: side.install.exitCode,
          durationMs: side.install.ms,
          stdoutTail: side.install.output.slice(-4000),
        });
        for (const c of side.checks)
          await recordSandboxExec(tx, {
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

      // Every other project the change touched is on the receipt too, its commands named by folder (review R2).
      for (const other of fix.others ?? [])
        for (const [phase, side] of [
          ["baseline", other.baseline],
          ["after", other.after],
        ] as const) {
          const folder = `[${other.root === "." ? "/" : other.root}] `;
          if (side.install.ms || side.install.output)
            await recordSandboxExec(tx, {
              runId,
              backend: backend.name,
              phase: phase === "baseline" ? "install_baseline" : "install_after",
              command: `${folder}install`,
              exitCode: side.install.exitCode,
              durationMs: side.install.ms,
              stdoutTail: side.install.output.slice(-4000),
            });
          for (const c of side.checks)
            await recordSandboxExec(tx, {
              runId,
              backend: backend.name,
              phase,
              command: `${folder}${c.argv.join(" ")}`,
              exitCode: c.exitCode,
              timedOut: c.timedOut,
              durationMs: c.ms,
              stdoutTail: c.output.slice(-4000),
            });
        }
    });

    const prMode = fix.evidence.prMode;
    const models = [...new Set([notesReceipt?.model, ...fix.attempts.map((a) => a.model)].filter(Boolean))];
    const runFields = {
      evidenceKind: fix.evidence.kind,
      prMode,
      verification: {
        baseline: fix.baseline.checks,
        after: fix.after.checks,
        reasons: fix.evidence.reasons,
        // Files that aren't plain (a symlink, an executable), so "Open draft anyway" publishes them as
        // the run left them; the diff carries only their text (U2 review).
        modes: Object.fromEntries(fix.files.filter((f) => f.mode).map((f) => [f.path, f.mode])),
        // Every other project the change touched, each with its own checks (D94): the run page's
        // proof panel lists them with their own ledger rows.
        others: (fix.others ?? []).map((o) => ({
          root: o.root,
          ecosystem: o.ecosystem,
          evidence: o.evidence.kind,
          reasons: o.evidence.reasons,
          baseline: o.baseline.checks,
          after: o.after.checks,
        })),
      },
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
      await update({
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
      await progress(
        `The newest major still failed its checks after the agent's attempts; trying ${outcome.fallback.version}${ctx.webUrl ? `: ${ctx.webUrl}/runs/${next.id}` : "."}`,
      );
      return { fellBack: outcome.fallback.version };
    }
    if (dry) {
      // The PR Teire would open, kept on the run for the report page; nothing is written to GitHub.
      await update({
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
    // Every write to GitHub from here on happens only while this worker holds the run.
    await beforePublish();
    if (prMode === "issue") published = true;

    if (prMode === "issue") {
      // No usable result: a "needs a human" issue with the evidence and the best diff.
      const existing = await getArtifact(db, repo.id, "issue", groupKey);
      // Every reason that reaches GitHub is redacted and shortened (review R18, round 2); the run
      // page keeps the full text.
      const body = `${composed.body}\n\n<sub>Teire stopped: ${saidOnGitHub(fix.evidence.reasons)}</sub>`;
      const issue = existing?.number
        ? // A closed issue whose change failed again is reopened, not edited out of sight (review R6).
          (
            await installation.octokit.rest.issues.update({
              owner,
              repo: name,
              issue_number: existing.number,
              body,
              state: "open",
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
      await update({
        ...runFields,
        status: "failed",
        step: "needs a human",
        finishedAt: new Date(),
      });
      await event("pr", "issue", { url: issue.html_url, evidence: fix.evidence.kind });
      // The Dashboard issue links "Needs a human" issues, and this group no longer offers "Fix now".
      await beforePublish();
      await syncDashboard(ctx, repo.id).catch(() => undefined);
      await progress(`Done: a person is needed, ${issue.html_url}`);
      await settleRunActions(db, runId, ["cancel-run"], {
        status: "refused",
        result: `Too late to stop: the run had already opened ${issue.html_url}`,
      });
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
    await beforePublish();
    published = true;
    const commit = await commitToBranch({
      octokit: installation.octokit,
      owner,
      repo: name,
      branch,
      baseSha: run.baseSha,
      botLogin: gh.botLogin,
      headline: `${config?.pullRequests?.commitMessage?.prefix ?? ""}${composed.title}`,
      body: `${fix.evidence.kind === "verified" ? "Verified" : "Draft"}: ${saidOnGitHub(fix.evidence.reasons)}`,
      files,
    });
    await beforePublish();
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
    await beforePublish();
    await publishCheckRun({
      octokit: installation.octokit,
      owner,
      repo: name,
      headSha: commit.oid,
      conclusion: fix.evidence.kind === "verified" ? "success" : "neutral",
      title: `${fix.evidence.kind.replace(/_/g, " ")}: ${outcome.checkTitle}`,
      summary: saidOnGitHub(fix.evidence.reasons),
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
      await beforePublish();
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
        a.kind === "issue" &&
        a.state === "open" &&
        a.number &&
        (a.changeKey === `stop/${lineage}` || a.changeKey.startsWith(`stop/${lineage}@`)),
    )) {
      await beforePublish();
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
    }
    await update({
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
    await beforePublish();
    await syncDashboard(ctx, repo.id).catch((error) =>
      event("dashboard", "failed", { error: String(error) }),
    );
    await progress(
      `Done: ${pr.url} (${prMode === "draft" ? `draft, ${fix.evidence.kind.replace(/_/g, " ")}` : "verified"}).`,
    );
    // A cancel that arrived after the PR was opened came too late to stop it; it says so.
    await settleRunActions(db, runId, ["cancel-run"], {
      status: "refused",
      result: `Too late to stop: the run had already opened ${pr.url}`,
    });
    return { pr: pr.url };
  } catch (error) {
    if (
      !(error instanceof LeaseLostError) &&
      !leaseLost &&
      (error instanceof RunCancelledError || abort.signal.aborted)
    ) {
      // Stopped because a person asked (or fixes turned Off): said on the run, its actions and its
      // progress comment. A run already marked cancelled by someone else keeps their words.
      const by = stopReason ? null : (cancelledBy ?? (await cancelRequest(db, runId))?.by ?? "a person");
      await updateHeldRun(db, runId, {
        status: "cancelled",
        step: stopReason ? "fixes off" : "cancelled by a person",
        error: stopReason ?? `cancelled by @${by} during ${lastStep}`,
        finishedAt: new Date(),
      });
      await appendEvent(db, runId, "run", "cancelled", { by, during: lastStep, reason: stopReason }).catch(
        () => undefined,
      );
      await settleRunActions(db, runId, ["cancel-run"], {
        status: "done",
        result: `Stopped during ${lastStep}; its sandboxes were closed`,
      });
      await settleRunActions(db, runId, ["fix", "rebase", "refresh", "recreate", "retry-run"], {
        status: "refused",
        result: stopReason ?? `Cancelled by @${by} before it finished`,
      });
      await progress(stopReason ? `Stopped: ${stopReason}` : `Cancelled by @${by} during ${lastStep}.`).catch(
        () => undefined,
      );
      return { cancelled: by ?? "fixes off" };
    }
    if (error instanceof LeaseLostError) {
      // Nothing more is written from here: the run belongs to the worker that took it.
      await appendEvent(db, runId, "run", "lease-lost", {
        worker: "this worker was paused past its lease",
      }).catch(() => undefined);
      return { skipped: "lease lost" };
    }
    if (error instanceof CreditsExhaustedError) {
      // Not this run's fault: it waits, and every other run waits, until credits are back.
      await markCreditsExhausted(db, error.message);
      await update({
        status: "queued",
        step: "waiting for Token Factory credits",
        error: error.message,
        workerId: null,
      });
      await event("queue", "deferred", { reason: error.message });
      await ctx.enqueueFix(runId, repo.id, BUDGET_RETRY_SECONDS);
      return { deferred: error.message };
    }
    if (error instanceof ResolverUnavailableError) {
      const tries = (await runEventsOf(db, runId, "resolver")).filter((e) => e.type === "deferred").length;
      if (tries < RESOLVER_RETRIES) {
        await progress(`Waiting: ${forGitHub(error.message)}; it tries again by itself.`);
        await update({
          status: "queued",
          step: "waiting for the dependency-file updater",
          error: error.message,
          workerId: null,
        });
        await event("resolver", "deferred", { reason: error.message, retry: tries + 1 });
        await ctx.enqueueFix(runId, repo.id, RESOLVER_RETRY_SECONDS * 2 ** tries);
        return { deferred: error.message };
      }
    }
    if (error instanceof ResolverNothingError) {
      const reason = `dependabot-core's updater: ${error.message}`;
      await update({
        status: "cancelled",
        step: "nothing to change",
        error: reason,
        finishedAt: new Date(),
      });
      await event("resolver", "nothing", { reason });
      await progress(`Nothing to change: ${forGitHub(reason)}.`);
      return { cancelled: true };
    }
    if (error instanceof ResolverStopError || error instanceof ResolverUnavailableError) {
      const reason =
        error instanceof ResolverStopError
          ? `${error.by === "updater" ? "dependabot-core's updater" : "Teire"} stopped (${error.type}): ${error.message}`
          : `the dependency-file updater was unavailable ${RESOLVER_RETRIES + 1} times: ${error.message}`;
      await update({ status: "failed", error: `stopped: ${reason}`, finishedAt: new Date() });
      await event("resolver", "stopped", { reason });
      // The updater's own words are quoted (D104), redacted and shortened for GitHub (review R18);
      // only while this worker still holds the run.
      if (!dry && installation) {
        await holdLease();
        await openStopIssue(
          ctx,
          installation.octokit,
          repo,
          run,
          groupKey,
          forGitHub(reason, STOP_REASON_CHARS),
        );
      }
      await progress(`Stopped: ${forGitHub(reason)}.`);
      return { stopped: reason };
    }
    const message =
      error instanceof HumanCommitsError
        ? `stopped: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    await update({ status: "failed", error: message, finishedAt: new Date() });
    await event("run", "failed", { error: message });
    // GitHub gets the short, redacted reason; the run page keeps the whole message (review R18).
    await progress(`Failed: ${forGitHub(message)}`);
    if (error instanceof HumanCommitsError) {
      // C6: a person pushed to Teire's branch; their commits are never overwritten.
      const open = await getArtifact(db, repo.id, "pr", groupKey);
      if (open?.number && open.state === "open" && (await renewLease(db, runId)))
        await installation?.octokit.rest.issues
          .createComment({
            owner,
            repo: name,
            issue_number: open.number,
            body: `Teire stopped updating this branch: ${forGitHub(error.message)}. Your commits stay; comment \`@teire recreate\` to start over from the current base.`,
          })
          .catch(() => undefined);
    }
    if (!(error instanceof HumanCommitsError)) throw error;
    return { stopped: message };
  } finally {
    clearInterval(heartbeat);
    clearInterval(watchCancel);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
