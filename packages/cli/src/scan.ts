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
  runtimesOf,
} from "@teire/engine/pipeline";
import { memoryCache } from "@teire/engine/registry";
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
  ecosystems: { name: string; projects: number; direct: number; transitive: number }[];
  findings: FindingDraft[];
  records: Map<string, ChangeV2>;
  providers: string[];
  notes: string[];
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
  uv: "install uv (https://docs.astral.sh/uv); it supplies Python 3.12 and the helper's pinned packages",
  java: "install Java 17 or newer, or set TEIRE_JAVA",
};

function plainNote(note: string) {
  return note.replace(/(?:[\w.-]+ failed: )?spawn (\S+) ENOENT/, (_, bin: string) => {
    const tool = bin.split("/").pop() as string;
    return `${tool} is not installed${TOOLS[tool] ? `: ${TOOLS[tool]}` : ""}`;
  });
}

export async function scanPath(
  dir: string,
  options: { catalogUrl: string; githubToken?: string },
): Promise<ScanResult> {
  const started = Date.now();
  const notes: string[] = [];
  const config = readTeireConfig(directoryTree(dir));
  for (const p of config.problems) notes.push(`teire.yml: ${p}`);
  const tree = scopedTree(directoryTree(dir), config);
  const cache = memoryCache();
  const token = options.githubToken;
  const base = {
    cache,
    cooldownDays: config.upgrades.cooldownDays,
    ...(token ? { githubToken: token } : {}),
  };
  const on = config.ecosystems;
  const run = async (name: string, enabled: boolean, fn: () => Promise<Assessed>) => {
    if (!enabled) return NONE;
    try {
      return await fn();
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 200);
      notes.push(`${name}: not scanned; ${message}`);
      return NONE;
    }
  };
  // One ecosystem at a time, as the worker runs them (registry rate limits, memory).
  const js = await run("npm", on.npm, () => assessJsRepo(dir, tree, base));
  const py = await run("PyPI", on.pypi, () => assessPyRepo(dir, tree, base));
  const go = await run("Go", on.go, () => assessGoRepo(dir, tree, base));
  const rust = await run("Cargo", on.cargo, () => assessRustRepo(dir, tree, base));
  const ruby = await run("RubyGems", on.rubygems, () => assessRubyRepo(dir, tree, base));
  const jvm = await run("Maven/Gradle", on.maven, () => assessJvmRepo(dir, tree, base));
  const groups = { npm: js, PyPI: py, Go: go, Cargo: rust, RubyGems: ruby, "Maven/Gradle": jvm };
  const projects = Object.values(groups).flatMap((g) => g.projects);
  const assessments = Object.values(groups).flatMap((g) => g.assessments);
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
    const origin = githubOrigin(dir);
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
      notes.push(...new Set(catalog.notes), ...api.discovery.notes.map((n) => `discovery: ${n}`));
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
    filesScanned: filesScanned || tree.files().length,
    ms: Date.now() - started,
  };
}
