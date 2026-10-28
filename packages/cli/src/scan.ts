import { execFileSync } from "node:child_process";
import { matchesTarget, readTeireConfig } from "@teire/engine/config";
import type { ChangeV2 } from "@teire/engine/contract";
import type { FindingDraft } from "@teire/engine/impact";
import { directoryTree, scopedTree } from "@teire/engine/inventory";
import { createTokenFactory, fetchModelPrices, tokenFactoryConfigFromEnv } from "@teire/engine/llm";
import {
  type ApiSources,
  type AssessedProject,
  type Assessment,
  assessApiChanges,
  assessGoRepo,
  assessJsRepo,
  assessJvmRepo,
  assessPyRepo,
  assessRubyRepo,
  assessRuntimes,
  assessRustRepo,
  newScanCoverage,
  runtimesOf,
  type ScanCoverage,
} from "@teire/engine/pipeline";
import { memoryCache } from "@teire/engine/registry";
import {
  cargoSurfaceDiff,
  goSurfaceDiff,
  jvmSurfaceDiff,
  npmSurfaceDiff,
  pypiSurfaceDiff,
  rubySurfaceDiff,
} from "@teire/engine/surface";
import { remoteCatalog } from "./catalog";

/**
 * `teire scan` (card C11): the worker's scan, run locally on a checkout through the same engine
 * calls, so its findings match the dashboard's. Package checks read the registries; API-host and
 * model checks read Teire's public catalog, and read a provider's pages here when the service has
 * not (see `remoteCatalog`). Wrapped model IDs are traced with Nemotron only when
 * `TOKENFACTORY_API_KEY` is set, as on the service.
 */
export interface ScanResult {
  root: string;
  /** What the report calls it: the folder, or github.com/owner/name@sha for a downloaded repository. */
  label: string;
  ecosystems: { name: string; projects: number; direct: number; transitive: number }[];
  /** Ecosystems with manifests that could not be read on this machine (the reason is in `notes`). */
  skipped: string[];
  findings: FindingDraft[];
  records: Map<string, ChangeV2>;
  providers: string[];
  notes: string[];
  /** What the scan could not check (D96): advisory sources down, version lookups that failed. */
  coverage: ScanCoverage;
  filesScanned: number;
  ms: number;
}

interface Assessed {
  projects: AssessedProject[];
  assessments: Assessment<AssessedProject>[];
}
const NONE: Assessed = { projects: [], assessments: [] };

/** `owner/name@sha` of a GitHub checkout, for the OpenAPI history of call-site files. */
function githubOrigin(dir: string) {
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(git("remote", "get-url", "origin"));
    return m ? { owner: m[1] as string, name: m[2] as string, sha: git("rev-parse", "HEAD") } : null;
  } catch {
    return null;
  }
}

/** What to install when a toolchain an ecosystem's reader runs is missing on this machine. */
const TOOLS: Record<string, string> = {
  go: "install Go (https://go.dev/dl) or set TEIRE_GO",
  "cargo-semver-checks":
    "cargo install cargo-semver-checks --version 0.51.0 --locked, or set TEIRE_CARGO_SEMVER_CHECKS",
  cargo: "install Rust (https://rustup.rs)",
  uv: "install uv (https://docs.astral.sh/uv) or Python 3.11+",
  java: "install Java 17 or newer, or set TEIRE_JAVA",
  oasdiff:
    "install oasdiff (https://github.com/oasdiff/oasdiff) to compare the OpenAPI spec of each endpoint the code calls, or set TEIRE_OASDIFF",
};

function plainNote(note: string) {
  return note
    .replace(
      "The operation was aborted due to timeout",
      "a download timed out; scanning again usually gets it",
    )
    .replace(/(?:[\w.-][\w .-]* failed: )?spawn (\S+) ENOENT/, (_, bin: string) => {
      const tool = bin.split("/").pop() as string;
      return `${tool} is not installed${TOOLS[tool] ? `: ${TOOLS[tool]}` : ""}`;
    });
}

/** One diff per package and version pair in a scan, however many of the repo's projects need it. */
function once<A extends string[], R>(fn: (...args: A) => Promise<R>) {
  const seen = new Map<string, Promise<R>>();
  return (...args: A) => {
    const key = args.join("\0");
    let result = seen.get(key);
    if (!result) {
      result = fn(...args);
      seen.set(key, result);
    }
    return result;
  };
}

/** Each ecosystem's manifests: its reader (and the toolchain it may need) runs only when one is present. */
const MANIFESTS: Record<string, RegExp> = {
  npm: /(^|\/)package\.json$/,
  PyPI: /(^|\/)(pyproject\.toml|Pipfile|requirements[^/]*\.(txt|in)|setup\.py|pylock[^/]*\.toml)$/,
  Go: /(^|\/)go\.(mod|work)$/,
  Cargo: /(^|\/)Cargo\.toml$/,
  RubyGems: /(^|\/)(Gemfile|gems\.rb)$/,
  "Maven/Gradle": /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/,
};

export async function scanPath(
  dir: string,
  options: {
    catalogUrl: string;
    githubToken?: string;
    label?: string;
    /** A repository downloaded from GitHub has no git remote to read its origin from. */
    origin?: { owner: string; name: string; sha: string };
    /** One line per step, so a long scan shows it is moving. */
    progress?: (step: string) => void;
  },
): Promise<ScanResult> {
  const started = Date.now();
  const notes: string[] = [];
  const skipped: string[] = [];
  const config = readTeireConfig(directoryTree(dir));
  for (const p of config.problems) notes.push(`teire.yml: ${p}`);
  const tree = scopedTree(directoryTree(dir), config);
  const cache = memoryCache();
  const token = options.githubToken;
  const coverage = newScanCoverage();
  const base = {
    cache,
    coverage,
    cooldownDays: config.upgrades.cooldownDays,
    ...(token ? { githubToken: token } : {}),
    ...(options.progress ? { onProgress: options.progress } : {}),
  };
  const on = config.ecosystems;
  const files = tree.files();
  const run = async (name: string, enabled: boolean, fn: () => Promise<Assessed>) => {
    if (!enabled || !files.some((f) => MANIFESTS[name]?.test(f))) return NONE;
    options.progress?.(`reading ${name} packages and their registries`);
    try {
      return await fn();
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 400);
      notes.push(`${name}: not scanned; ${message}`);
      skipped.push(name);
      return NONE;
    }
  };
  // One ecosystem at a time, as the worker runs them (registry rate limits, memory).
  const js = await run("npm", on.npm, () =>
    assessJsRepo(dir, tree, { ...base, surfaceDiff: once((n, f, t) => npmSurfaceDiff(n, f, t, base)) }),
  );
  const py = await run("PyPI", on.pypi, () =>
    assessPyRepo(dir, tree, { ...base, surfaceDiff: once((n, f, t) => pypiSurfaceDiff(n, f, t, base)) }),
  );
  const go = await run("Go", on.go, () =>
    assessGoRepo(dir, tree, { ...base, surfaceDiff: once(goSurfaceDiff) }),
  );
  const rust = await run("Cargo", on.cargo, () =>
    assessRustRepo(dir, tree, { ...base, surfaceDiff: once((n, f, t) => cargoSurfaceDiff(n, f, t)) }),
  );
  const ruby = await run("RubyGems", on.rubygems, () =>
    assessRubyRepo(dir, tree, { ...base, surfaceDiff: once(rubySurfaceDiff) }),
  );
  const jvm = await run("Maven/Gradle", on.maven, () =>
    assessJvmRepo(dir, tree, { ...base, surfaceDiff: once(jvmSurfaceDiff) }),
  );
  const groups = { npm: js, PyPI: py, Go: go, Cargo: rust, RubyGems: ruby, "Maven/Gradle": jvm };
  const projects = Object.values(groups).flatMap((g) => g.projects);
  const assessments = Object.values(groups).flatMap((g) => g.assessments);
  // A package whose version the repo doesn't pin (no lockfile, a BOM sets it) is listed but not
  // compared: say how many and why, so "nothing affected" is never read as "all checked".
  for (const [name, g] of Object.entries(groups)) {
    const direct = g.projects.flatMap((p) => p.instances).filter((i) => i.direct && i.source === "registry");
    const open = direct.filter((i) => !i.version);
    if (!open.length) continue;
    const reasons = new Map<string, number>();
    for (const i of open) {
      const why = i.unresolvedReason?.replace(/ "[^"]*"/, "") ?? "unresolved";
      reasons.set(why, (reasons.get(why) ?? 0) + 1);
    }
    const top = [...reasons].sort((a, b) => b[1] - a[1])[0]?.[0];
    notes.push(
      `${name}: ${open.length} of ${direct.length} direct packages were not compared; ${top}${top === "no Gemfile.lock" ? " (commit one to check them)" : ""}`,
    );
  }
  // A diff the machine could not compute (no Java, no Go toolchain…) says why, never guesses.
  for (const a of assessments)
    if (a.diff?.unanalyzable && a.decision?.kind === "upgrade")
      notes.push(`${a.instance.name} ${a.instance.version} → ${a.decision.to}: ${a.diff.notes.join("; ")}`);

  const records = new Map<string, ChangeV2>();
  for (const a of assessments)
    for (const r of [...a.records, ...(a.deprecation ? [a.deprecation] : [])]) records.set(r.id, r);
  let apiFindings: FindingDraft[] = [];
  let providers: string[] = [];
  let filesScanned = 0;
  if (on.apis) {
    options.progress?.("looking for API hosts and model IDs in the code");
    const origin = options.origin ?? githubOrigin(dir);
    let triage: ApiSources["triage"];
    if (process.env.TOKENFACTORY_API_KEY)
      triage = { tf: createTokenFactory(tokenFactoryConfigFromEnv()), prices: await fetchModelPrices() };
    const catalog = remoteCatalog(options.catalogUrl, { cache, ...(triage ? { reader: triage } : {}) });
    try {
      const api = await assessApiChanges(
        dir,
        tree,
        projects.flatMap((p) => p.instances),
        {
          changes: catalog.changes,
          discover: { cache: catalog.discovery },
          ...(triage ? { triage } : {}),
          openapi: { cache, ...(token ? { githubToken: token } : {}), ...(origin ? { repo: origin } : {}) },
          declared: config.sources,
        },
      );
      apiFindings = api.findings;
      filesScanned = api.scan.filesScanned;
      providers = api.providers.map((p) => p.provider.name);
      for (const r of api.records) records.set(r.id, r);
      notes.push(...catalog.notes(), ...api.discovery.notes.map((n) => `discovery: ${n}`));
      for (const n of api.openapiNotes) notes.push(`OpenAPI: ${n}`);
      const open = api.findings.filter(
        (f) =>
          f.verdict === "inconclusive" &&
          (f.changeKind === "model-retirement" || f.changeKind === "model-rerouted"),
      );
      if (!triage && open.length)
        notes.push(
          `${open.length} model mention(s) not traced through wrappers or registries (Nemotron does this when TOKENFACTORY_API_KEY is set)`,
        );
    } catch (error) {
      notes.push(
        `API hosts and models: not checked (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  const runtimes = await assessRuntimes(runtimesOf(tree, js.projects as never, py.projects as never), {
    cache,
  }).catch((error) => {
    notes.push(`runtimes: not checked (${error instanceof Error ? error.message : String(error)})`);
    return null;
  });
  for (const r of runtimes?.records ?? []) records.set(r.id, r);
  const findings = [
    ...assessments.flatMap((a) => a.findings),
    ...apiFindings,
    ...(runtimes?.findings ?? []),
  ].filter((f) => !config.ignore.some((t) => matchesTarget(t, f)));
  return {
    root: dir,
    label: options.label ?? dir,
    skipped,
    ecosystems: Object.entries(groups)
      .filter(([, g]) => g.projects.length)
      .map(([name, g]) => {
        const instances = g.projects.flatMap((p) => p.instances);
        return {
          name,
          projects: g.projects.length,
          direct: instances.filter((i) => i.direct).length,
          transitive: instances.filter((i) => !i.direct).length,
        };
      }),
    findings,
    records,
    providers,
    notes: [...new Set(notes.map(plainNote))],
    coverage,
    filesScanned: filesScanned || tree.files().length,
    ms: Date.now() - started,
  };
}
