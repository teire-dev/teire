import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { PageReader } from "../catalog/adapters/vendor-page";
import { type IngestOptions, ingestProvider } from "../catalog/ingest";
import { PROVIDERS } from "../catalog/providers";
import type { ProviderRecord } from "../catalog/schema";
import { CATALOG_SCHEMA_VERSION, providerRecord, slugify } from "../catalog/schema";
import { sha256 } from "../catalog/source";
import type { DeclaredSource } from "../config";
import type { ChangeV2, DependencyInstance } from "../contract";
import {
  discoverProviders,
  type ProviderCandidate,
  type ProviderUse,
  providerCandidates,
  type TavilyUsage,
} from "../discover";
import { registrableDomain } from "../discover/domains";
import type { CodemodEdit, MigrationNote } from "../fix/codemods";
import { type FileChange, type FixRun, runFix } from "../fix/run";
import type { Transaction } from "../fix/transaction";
import { composeApiChangePullRequest } from "../github/compose";
import {
  applyBaseUrlOverrides,
  assessProviderChanges,
  type FindingDraft,
  type TriageReceipt,
  triageModelSites,
} from "../impact";
import { readGoInventory } from "../inventory/go";
import { readJsInventory } from "../inventory/js";
import { readJvmInventory } from "../inventory/jvm";
import { readPythonInventory } from "../inventory/python";
import { readRubyInventory } from "../inventory/ruby";
import { readRustInventory } from "../inventory/rust";
import type { RepoTree } from "../inventory/tree";
import { findBaseUrlOverrides } from "../locate/base-url";
import { type LiteralScan, locateLiterals } from "../locate/literals";
import { assessOpenApi, type OpenApiOptions } from "../openapi";
import type { RegistryOptions } from "../registry/clients";
import { checkableProjects, planFor } from "../verify/projects";
import type { FixDependencyInput } from "./js";

/**
 * API changes a provider announced, for the providers this repo talks to (plan S04, D82). Nothing is
 * read ahead of time: the repo's own dependencies and code name the providers (an installed SDK, an
 * API host in a URL literal), and only those providers' change sources are read, through the
 * caller's cache (the worker shares them across repos, like package diffs). The literal scan then
 * finds the retired models and removed endpoints the repo uses; each becomes a finding. The fix swaps
 * each model ID where it is used as a model for the provider's named replacement, then the same
 * baseline-vs-after verification and agent loop as an upgrade adapts whatever else the swap needs.
 * Nothing in the manifest or lockfile changes.
 */
export interface ApiAssessment {
  scan: LiteralScan;
  findings: FindingDraft[];
  /** Providers the repo uses, and why (the SDK package or host that names each). */
  providers: ProviderUse[];
  /** The change records read for those providers. */
  records: ChangeV2[];
  /** Providers found with no reader: candidates looked at, Tavily calls, and why any found nothing. */
  discovery: { candidates: number; usage: TavilyUsage[]; notes: string[] };
  /** Nemotron readings that traced wrapped model IDs (empty without `triage`). */
  receipts: TriageReceipt[];
  /** What the OpenAPI comparison looked at per host, or why it compared nothing. */
  openapiNotes: string[];
}

/** Reads a provider's change records (worker: stored and refreshed when stale; scripts: live). */
export type ProviderChanges = (providers: ProviderRecord[]) => Promise<ChangeV2[]>;

/** Where provider changes come from for one scan. */
export interface ApiSources {
  changes: ProviderChanges;
  /**
   * Finding providers with no reader (an API host in the code, an installed SDK's own base URL):
   * registry access for reading the SDKs, and the discovery cache. Omitted, only the curated readers apply.
   */
  discover?: RegistryOptions & { cacheDir?: string };
  /** Nemotron for model IDs the syntax cannot place (registries, wrappers). Omitted, they stay inconclusive. */
  triage?: PageReader;
  /** OpenAPI diffs for operations the repo calls by URL (spec lookup, the repo's history). */
  openapi?: OpenApiOptions;
  /** `teire.yml` sources: an API host's changelog or spec named by the repo itself. */
  declared?: DeclaredSource[];
}

/**
 * A changelog the repo names for an API host (`sources: [{host, changelogUrl}]`): read like a
 * discovered page, through the guarded fetch and the quote gate, on the page's own domain. Its
 * records carry the repo's trust and stay private.
 */
export function declaredProviders(declared: DeclaredSource[], now = new Date()): ProviderUse[] {
  const out: ProviderUse[] = [];
  for (const d of declared) {
    if (!d.host || !d.changelogUrl) continue;
    const domain = registrableDomain(new URL(d.changelogUrl).hostname);
    if (!domain) continue;
    out.push({
      provider: providerRecord.parse({
        schemaVersion: CATALOG_SCHEMA_VERSION,
        slug: `declared-${slugify(d.host)}-${sha256(d.changelogUrl).slice(0, 8)}`,
        name: d.host,
        homepage: `https://${domain}`,
        logo: { light: "/logos/provider.svg", dark: "/logos/provider.svg" },
        officialDomains: [domain],
        sources: [{ kind: "custom", url: d.changelogUrl, adapter: "discovered" }],
        detection: { imports: [], envVars: [], baseUrls: [d.host], calls: [] },
        discovery: { at: now.toISOString(), via: ["teire.yml"], tavilyCredits: 0, evidence: ["teire.yml"] },
      }),
      via: ["teire.yml"],
    });
  }
  return out;
}

/** Every exact model ID the confirmed records name, for one scan of the repo. */
export function catalogModelIds(records: ChangeV2[]) {
  const ids = new Set<string>();
  for (const r of records)
    if (r.status === "confirmed")
      for (const s of r.signatures) if (s.kind === "string-literal") ids.add(s.value);
  return ids;
}

/**
 * The providers a repo talks to: one of the provider's SDK packages is installed, or the provider's
 * API host appears in a URL in the code. An OpenAI-compatible provider reached through the OpenAI
 * SDK (Token Factory) counts once its host is in the code.
 */
/** An installed package is the SDK; a Go SDK's base path matches every major (`openai-go/v3`). */
function sdkMatches(i: { ecosystem: string; name: string }, sdk: { ecosystem: string; name: string }) {
  if (i.ecosystem !== sdk.ecosystem) return false;
  return (
    i.name === sdk.name ||
    (sdk.ecosystem === "go" && /^\/v\d+$/.test(i.name.slice(sdk.name.length)) && i.name.startsWith(sdk.name))
  );
}

export function providersUsed(
  instances: Pick<DependencyInstance, "ecosystem" | "name">[],
  hosts: ReadonlySet<string>,
  catalog: readonly ProviderRecord[] = PROVIDERS,
) {
  const used: { provider: ProviderRecord; via: string[] }[] = [];
  for (const provider of catalog) {
    const own = provider.detection.baseUrls.filter((h) => hosts.has(h));
    const sharedWithAnother = (sdk: (typeof provider.sdks)[number]) =>
      catalog.some(
        (p) => p !== provider && p.sdks.some((x) => x.ecosystem === sdk.ecosystem && x.name === sdk.name),
      );
    const sdks = provider.sdks
      .filter((sdk) => !(sharedWithAnother(sdk) && provider.detection.imports.length === 0))
      .filter((sdk) => instances.some((i) => sdkMatches(i, sdk)))
      .map((sdk) => `${sdk.ecosystem}:${sdk.name}`);
    if (own.length || sdks.length) used.push({ provider, via: [...sdks, ...own] });
  }
  return used;
}

/** Reads each provider's sources live when first asked, once per process (scripts and tests). */
export function liveProviderChanges(options: IngestOptions = {}): ProviderChanges {
  const read = new Map<string, Promise<ChangeV2[]>>();
  return async (providers) => {
    const lists = providers.map((p) => {
      const known = read.get(p.slug);
      if (known) return known;
      const pending = ingestProvider(p, options).then((r) => r.records);
      read.set(p.slug, pending);
      return pending;
    });
    return (await Promise.all(lists)).flat();
  };
}

/** Every package the repo locks, in all six ecosystems, for provider detection (S16.1). */
export async function repoInstances(repoDir: string, tree: RepoTree) {
  return [
    ...readJsInventory(tree).flatMap((p) => p.instances),
    ...(await readPythonInventory(repoDir, tree)).flatMap((p) => p.instances),
    ...(await readGoInventory(repoDir, tree)).flatMap((p) => p.instances),
    ...readRustInventory(tree).flatMap((p) => p.instances),
    ...readRubyInventory(tree).flatMap((p) => p.instances),
    ...readJvmInventory(tree).flatMap((p) => p.instances),
  ];
}

export async function assessApiChanges(
  repoDir: string,
  tree: RepoTree,
  instances: Pick<DependencyInstance, "ecosystem" | "name" | "version" | "direct" | "scope" | "source">[],
  sources: ApiSources,
  now = new Date(),
): Promise<ApiAssessment> {
  // First pass: URLs only, to see which API hosts the code calls.
  const hostsScan = await locateLiterals({ repoDir, tree, modelIds: new Set() });
  const hosts = new Set(hostsScan.hits.flatMap((h) => (h.host ? [h.host] : [])));
  const providers: ProviderUse[] = [
    ...providersUsed(instances, hosts),
    ...declaredProviders(sources.declared ?? [], now),
  ];
  const discovery: ApiAssessment["discovery"] = { candidates: 0, usage: [], notes: [] };
  if (sources.discover) {
    const candidates: ProviderCandidate[] = await providerCandidates({
      urls: hostsScan.hits.flatMap((h) => (h.host ? [{ host: h.host, path: h.path ?? "/" }] : [])),
      instances,
      known: PROVIDERS,
      options: sources.discover,
    });
    discovery.candidates = candidates.length;
    if (candidates.length) {
      const found = await discoverProviders(candidates, { ...sources.discover, now });
      providers.push(...found.used);
      discovery.usage = found.usage;
      discovery.notes = found.notes;
    }
  }
  if (!providers.length)
    return {
      scan: hostsScan,
      findings: [],
      providers,
      records: [],
      discovery,
      receipts: [],
      openapiNotes: [],
    };
  const records = await sources.changes(providers.map((p) => p.provider));
  const scan = await locateLiterals({ repoDir, tree, modelIds: catalogModelIds(records) });
  let findings = assessProviderChanges({ records, scan, now });
  let receipts: TriageReceipt[] = [];
  if (sources.triage) {
    const triaged = await triageModelSites({
      repoDir,
      tree,
      findings,
      records,
      providers: new Map(providers.map((p) => [p.provider.slug, { name: p.provider.name, via: p.via }])),
      reader: sources.triage,
      now,
    });
    findings = triaged.findings;
    receipts = triaged.receipts;
  }
  // Last: a client whose base URL the deployment sets makes its provider's model findings a question.
  findings = applyBaseUrlOverrides(
    findings,
    records,
    providers.map((p) => p.provider),
    findBaseUrlOverrides(repoDir, tree),
  );
  // OpenAPI: operations the repo reaches by URL, compared at its position on the API and the latest.
  let openapiNotes: string[] = [];
  if (sources.openapi) {
    try {
      const oas = await assessOpenApi({
        repoDir,
        tree,
        hits: scan.hits,
        providers,
        options: {
          ...sources.openapi,
          declared: (sources.declared ?? []).flatMap((d) =>
            d.host && d.specUrl ? [{ host: d.host, specUrl: d.specUrl }] : [],
          ),
        },
        now,
      });
      records.push(...oas.records);
      findings = [...findings, ...oas.findings];
      openapiNotes = oas.notes;
    } catch (error) {
      openapiNotes = [`OpenAPI comparison failed: ${error instanceof Error ? error.message : String(error)}`];
    }
  }
  return { scan, findings, providers, records, discovery, receipts, openapiNotes };
}

/** A confirmed retirement of this exact model ID (shut down already or on a date). */
function retirementOf(id: string, related: ChangeV2[]) {
  return related.find(
    (r) =>
      r.status === "confirmed" &&
      r.kind === "model-retirement" &&
      (r.applicability.class === "already-broken" || r.applicability.class === "breaks-on-date") &&
      r.signatures.some((s) => s.kind === "string-literal" && s.value === id),
  );
}

/**
 * Where a named replacement leads when the provider has retired it too (Groq named
 * `qwen/qwen3.6-27b` for `llama-3.3-70b-versatile`, then shut `qwen/qwen3.6-27b` down in favour of
 * `qwen/qwen3.8-27b`): followed while each step names exactly one replacement.
 */
export function replacementChain(id: string, related: ChangeV2[], maxHops = 5) {
  const hops: { from: string; to: string | null; record: ChangeV2 }[] = [];
  let current = id;
  const seen = new Set([id]);
  for (let i = 0; i < maxHops; i++) {
    const r = retirementOf(current, related);
    if (!r) break;
    const next = r.replacement?.modelIds.length === 1 ? (r.replacement.modelIds[0] ?? null) : null;
    hops.push({ from: current, to: next, record: r });
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  const last = hops.at(-1);
  return { final: last && !last.to ? null : current, hops };
}

/**
 * Model swaps at the located literals: every affected finding's sites whose record names exactly
 * one replacement, followed to the provider's current model when that replacement was retired too.
 * Several swaps on one line become one edit.
 */
export function planModelSwaps(
  repoDir: string,
  findings: FindingDraft[],
  records: ChangeV2[],
  related: ChangeV2[] = records,
): CodemodEdit[] {
  const byLine = new Map<
    string,
    { file: string; line: number; swaps: { column: number; from: string; to: string; record: ChangeV2 }[] }
  >();
  for (const f of findings) {
    if (f.verdict !== "affected") continue;
    const record = records.find((r) => r.id === f.changeId);
    const spec =
      record?.replacement?.codemod?.kind === "model-swap"
        ? (record.replacement.codemod.spec as { to?: string })
        : null;
    const from = f.position.version;
    if (!record || !spec?.to || !from) continue;
    // A replacement retired in turn leads to its own replacement; a chain that forks stops the swap.
    const to = replacementChain(spec.to, related).final;
    if (!to) continue;
    for (const site of f.callSites) {
      const key = `${site.file}:${site.line}`;
      const entry = byLine.get(key) ?? { file: site.file, line: site.line, swaps: [] };
      entry.swaps.push({ column: site.column - 1, from, to, record });
      byLine.set(key, entry);
    }
  }
  const edits: CodemodEdit[] = [];
  for (const { file, line, swaps } of byLine.values()) {
    let text: string;
    let whole: string;
    try {
      whole = readFileSync(join(repoDir, file), "utf8");
      text = whole.split("\n")[line - 1] ?? "";
    } catch {
      continue;
    }
    // A line that is one entry of a list of models (a catalogue the repo offers) is not swapped when
    // the file already lists the replacement: that would list it twice; the agent decides (round 2).
    const listEntry = /^\s*["'`][^"'`]+["'`]\s*,?\s*$/.test(text);
    let after = text;
    const applied: string[] = [];
    // Right to left, so earlier columns stay valid.
    for (const s of [...swaps].sort((a, b) => b.column - a.column)) {
      if (after.slice(s.column, s.column + s.from.length) !== s.from) continue;
      if (listEntry && ['"', "'", "`"].some((q) => whole.includes(`${q}${s.to}${q}`))) continue;
      after = after.slice(0, s.column) + s.to + after.slice(s.column + s.from.length);
      applied.push(`${s.from} → ${s.to}`);
    }
    if (after !== text)
      edits.push({
        file,
        line,
        before: text,
        after,
        reason: `model swap ${applied.reverse().join(", ")}`,
        noteUrl: swaps[0]?.record.sources[0]?.url ?? "",
      });
  }
  return [...edits, ...expectationSwaps(repoDir, edits)];
}

/**
 * An equality assertion just before a quoted value: `eq("`, `toBe("`, `assertEquals("`, `Equal(t, "`,
 * minitest's `assert_equal "`, `== "`, and Go's `if got != "` (the test fails unless they are
 * equal). A negated one (`not_to eq`, `.not.toBe`, `assert_not_equal`, Python's `assert x != "`)
 * keeps its value: moving it would assert the opposite (review round 2).
 */
const EXPECTATION =
  /(?:\beql?|\bequal|assert_equal|toBe|toEqual|toStrictEqual|toHaveBeenCalledWith|assertEquals?|assert_eq!?|assertEqual|isEqualTo|Equalf?\(\s*t\s*,|==|!=)\s*\(?\s*["'`]$/;
const NEGATED =
  /\bnot_to\b|\bto_not\b|\.not\.|\.not\(|assert_not_equal|refute_equal|assertNotEquals?|assert_ne!|isNotEqualTo|NotEqualf?\(|\bassert\b[^=]*!=/;
const TEST_PATH =
  /(?:^|\/)(?:spec|specs|test|tests|__tests__)\/|(?:_spec|_test|\.test|\.spec|Test|Tests)\.[a-z]+$|(?:^|\/)test_[^/]+\.py$/;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
]);

/** Every file under a directory (bounded), relative paths. */
function filesUnder(root: string, cap = 20_000) {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(rel);
      } else out.push(rel);
    }
  };
  walk("");
  return out;
}

/**
 * The tests that pin a swapped value move with it: once the code's model changes, an equality
 * assertion on the exact retired ID (`expect(provider.default_model).to eq("claude-3-5-…")`) in the
 * swapped files or the tests paired with them expects the replacement. Without this a spec held the
 * old ID while the code moved, and the agent edited back and forth for 96 steps (live walk,
 * teire-dev/bristow). A test that only mentions an ID (a list of retired names) is left alone.
 */
export function expectationSwaps(repoDir: string, swaps: CodemodEdit[]): CodemodEdit[] {
  const pairs = [
    ...new Map(
      swaps
        .flatMap((e) => e.reason.replace(/^model swap /, "").split(", "))
        .map((p) => p.split(" → ") as [string, string])
        .filter(([from, to]) => from && to)
        .map(([from, to]) => [from, to] as const),
    ),
  ];
  if (!pairs.length) return [];
  const stems = new Set(
    swaps.map((e) =>
      basename(e.file)
        .replace(/\.[^.]+$/, "")
        .toLowerCase(),
    ),
  );
  const touched = new Set(swaps.map((e) => `${e.file}:${e.line}`));
  const candidates = filesUnder(repoDir).filter((f) => {
    if (swaps.some((e) => e.file === f)) return true;
    if (!TEST_PATH.test(f)) return false;
    const stem = basename(f)
      .replace(/\.[^.]+$/, "")
      .replace(/^test_|_spec$|_test$|\.test$|\.spec$|Tests?$/g, "")
      .toLowerCase();
    return stems.has(stem);
  });
  const edits: CodemodEdit[] = [];
  for (const file of candidates) {
    let lines: string[];
    try {
      lines = readFileSync(join(repoDir, file), "utf8").split("\n");
    } catch {
      continue;
    }
    lines.forEach((text, i) => {
      if (touched.has(`${file}:${i + 1}`)) return;
      let after = text;
      const applied: string[] = [];
      for (const [from, to] of pairs) {
        for (const q of ['"', "'", "`"]) {
          const needle = `${q}${from}${q}`;
          let at = after.indexOf(needle);
          while (at >= 0) {
            const lead = after.slice(0, at + 1);
            if (EXPECTATION.test(lead) && !NEGATED.test(lead)) {
              after = `${after.slice(0, at + 1)}${to}${after.slice(at + 1 + from.length)}`;
              applied.push(`${from} → ${to}`);
            }
            at = after.indexOf(needle, at + 1);
          }
        }
      }
      if (after !== text)
        edits.push({
          file,
          line: i + 1,
          before: text,
          after,
          reason: `model swap ${[...new Set(applied)].join(", ")} (a test's expected value)`,
          noteUrl: swaps[0]?.noteUrl ?? "",
        });
    });
  }
  return edits;
}

/** The provider's own words for each change, plus its parameter changes (what a new model may reject). */
function providerNotes(
  group: ChangeV2[],
  related: ChangeV2[],
  usedInRepo: (token: string) => boolean = () => true,
): MigrationNote[] {
  const notes: MigrationNote[] = [];
  // Replacements the provider has retired since: their own notices travel with the change.
  const chained = new Set<ChangeV2>();
  for (const r of group)
    for (const id of r.replacement?.modelIds ?? [])
      for (const hop of replacementChain(id, related).hops)
        if (!group.includes(hop.record)) chained.add(hop.record);
  for (const r of chained) {
    const source = r.sources[0];
    const id = r.signatures.find((s) => s.kind === "string-literal");
    if (!source?.quote || id?.kind !== "string-literal") continue;
    notes.push({
      summary: `${id.value}, named as a replacement, was itself retired${r.applicability.effectiveOn ? ` on ${r.applicability.effectiveOn}` : ""}${r.replacement ? `; the provider names ${r.replacement.value}` : ""}`,
      apis: [id.value],
      replacement: r.replacement?.value ?? null,
      quote: source.quote,
      url: source.url,
    });
  }
  // A parameter change travels with the fix only when the repo passes that parameter.
  const params = related.filter(
    (x) =>
      x.kind === "parameter-change" &&
      !group.includes(x) &&
      x.signatures.some((sig) => sig.kind === "call-arg" && usedInRepo(sig.arg)),
  );
  for (const r of [...group, ...params]) {
    const source = r.sources[0];
    if (!source?.quote) continue;
    notes.push({
      summary: `${r.title}${r.applicability.apiVersion?.to ? ` (API version ${r.applicability.apiVersion.to})` : ""}`,
      apis: r.signatures.flatMap((s) =>
        s.kind === "string-literal" ? [s.value] : s.kind === "call-arg" ? [s.arg] : [],
      ),
      replacement: r.replacement?.value ?? null,
      quote: [source.quote, ...r.migrationNotes.map((m) => m.text)].join(" "),
      url: source.url,
    });
  }
  return notes.filter((n, i) => notes.findIndex((m) => m.quote === n.quote) === i);
}

const QUOTED = /(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g;
const shape = (line: string) =>
  line
    .replace(QUOTED, '""')
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .trim();

/**
 * What each retired model became in the final code, read from the change itself: the site's line
 * after the fix (the line of the same shape, nearest the original), and the literal at the same
 * position. A provider that names several replacements leaves the choice to the agent; this says
 * which one it made.
 */
export function appliedSwaps(files: FileChange[], findings: FindingDraft[]) {
  const out: { from: string; to: string }[] = [];
  for (const f of findings) {
    const from = f.position.version;
    if (f.verdict !== "affected" || !from) continue;
    for (const site of f.callSites) {
      const file = files.find((x) => x.path === site.file);
      if (!file || file.after === null) continue;
      const before = file.before.split("\n")[site.line - 1] ?? "";
      const k = [...before.matchAll(QUOTED)].findIndex((m) => m[2] === from);
      if (k < 0) continue;
      const lines = file.after.split("\n");
      const candidates = lines
        .map((text, i) => ({ text, i }))
        .filter((l) => shape(l.text) === shape(before))
        .sort((a, b) => Math.abs(a.i - (site.line - 1)) - Math.abs(b.i - (site.line - 1)));
      const to = candidates[0] ? [...candidates[0].text.matchAll(QUOTED)][k]?.[2] : undefined;
      if (to && to !== from && !out.some((o) => o.from === from && o.to === to)) out.push({ from, to });
    }
  }
  return out;
}

/** Whether a token appears as a whole word in the repo's source files (read once, on first use). */
function wordsIn(repoDir: string, tree: RepoTree) {
  let text: string | null = null;
  return (token: string) => {
    if (text === null) {
      text = "";
      for (const f of tree.files()) {
        if (
          !/\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|ya?ml|toml|json)$/.test(f) ||
          /node_modules|\.venv|dist\/|lock/.test(f)
        )
          continue;
        try {
          text += `\n${readFileSync(join(repoDir, f), "utf8")}`;
        } catch {
          // unreadable: skipped
        }
        if (text.length > 8_000_000) break;
      }
    }
    return new RegExp(`(?<![\\w-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text);
  };
}

/** The project whose checks prove the change: the JS or Python project holding most edited files. */
/**
 * The project whose checks verify an API fix (S16.2): the one in any of the six ecosystems holding
 * most of the changed files, deepest first, with teire.yml's `verify` commands applied.
 */
async function checksFor(
  repoDir: string,
  tree: RepoTree,
  files: string[],
  verify?: FixDependencyInput["verify"],
) {
  const within = (root: string) => files.filter((f) => root === "." || f.startsWith(`${root}/`)).length;
  const best = (await checkableProjects(repoDir, tree)).sort(
    (a, b) => within(b.root) - within(a.root) || b.root.length - a.root.length,
  )[0];
  if (!best) throw new Error("no project in a supported ecosystem to verify the change in");
  return { plan: planFor(best, verify), project: { root: best.root, manager: best.plan().manager } };
}

export interface FixApiInput extends Omit<FixDependencyInput, "assessment"> {
  /** One pull request's findings (one group key). */
  findings: FindingDraft[];
  /** The records those findings point at. */
  records: ChangeV2[];
  /** Every confirmed record of the same provider: parameter changes travel with a model swap. */
  related: ChangeV2[];
  /** The provider's display name ("Groq"), for the title. */
  providerName?: string;
}

export async function fixApiChanges(
  input: FixApiInput,
): Promise<{ run: FixRun; pr: { title: string; body: string }; groupKey: string }> {
  const affected = input.findings.filter((f) => f.verdict === "affected");
  const groupKey = affected[0]?.groupKey ?? input.findings[0]?.groupKey ?? "api";
  const records = input.records.filter((r) => affected.some((f) => f.changeId === r.id));
  const related = [...records, ...input.related.filter((r) => !records.includes(r))];
  const edits = planModelSwaps(input.repoDir, affected, records, related);
  const files = [...new Set(affected.flatMap((f) => f.callSites.map((s) => s.file)))];
  const { plan, project } = await checksFor(input.repoDir, input.tree, files, input.verify);
  const swapped = edits.flatMap((e) =>
    e.reason
      .replace(/^model swap /, "")
      .replace(/ \(a test's expected value\)$/, "")
      .split(", "),
  );
  // Changes Teire could not swap on its own: several replacements, or a chain that forks.
  const choices = affected
    .filter((f) => !swapped.some((s) => s.startsWith(`${f.position.version} → `)))
    .map((f) => {
      const r = records.find((x) => x.id === f.changeId);
      const options = (r?.replacement?.modelIds ?? []).map((id) => {
        const chain = replacementChain(id, related);
        return chain.hops.length
          ? `${id} (itself retired; ${chain.final ? `now ${chain.final}` : "the provider names several replacements"})`
          : id;
      });
      return `${f.position.version}: ${options.length ? `the provider names ${options.join(" or ")}` : "the provider names no replacement"}`;
    })
    .filter((v, i, all) => all.indexOf(v) === i);
  const swaps = [...new Set([...swapped, ...choices])];
  const transaction: Transaction = {
    describe: "no package change: code edits only",
    manifest: [],
    commands: [],
    readBack: [],
  };
  const notes = providerNotes(records, input.related, wordsIn(input.repoDir, input.tree));
  const run = await runFix({
    verify: input.verify,
    tf: input.tf,
    prices: input.prices,
    backend: input.backend,
    runId: input.runId,
    repoDir: input.repoDir,
    tree: input.tree,
    tarball: input.tarball,
    project,
    plan,
    transaction,
    target: swaps.join(", "),
    headline: [
      `API change: ${records.map((r) => r.title).join("; ")}.`,
      swapped.length
        ? `Teire swapped the model IDs where they are used as models (${swapped.join(", ")}).`
        : "",
      choices.length
        ? `Choose the replacement for each of these from the provider's own options, and never one it has retired: ${choices.join("; ")}.`
        : "",
      "Make the code and tests pass with the new models, and check the parameter changes quoted below.",
    ]
      .filter(Boolean)
      .join(" "),
    edits,
    // A retired model already fails on the baseline: only passing checks prove the fix.
    requirePassing: records.some((r) => r.applicability.class === "already-broken"),
    findings: affected,
    records,
    notes: [...notes, ...(input.extraNotes ?? [])],
    targetDir: input.repoDir,
    targetPaths: new Set(),
    docs: async () =>
      "Provider documentation for this change is quoted in the migration notes; there is no package to look up.",
    onEvent: input.onEvent,
  });
  const pr = composeApiChangePullRequest({
    applied: appliedSwaps(run.files, affected),
    ...(input.providerName ? { providerName: input.providerName } : {}),
    repo: input.repo,
    runId: input.runId,
    ...(input.runUrl ? { runUrl: input.runUrl } : {}),
    groupKey,
    findings: input.findings,
    records,
    run,
    plan,
    backendNote: input.backendNote,
    notes,
  });
  return { run, pr, groupKey };
}
