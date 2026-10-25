import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type IngestOptions, ingestProvider } from "../catalog/ingest";
import { PROVIDERS } from "../catalog/providers";
import type { ProviderRecord } from "../catalog/schema";
import type { ChangeV2, DependencyInstance } from "../contract";
import type { CodemodEdit, MigrationNote } from "../fix/codemods";
import { type FixRun, runFix } from "../fix/run";
import type { Transaction } from "../fix/transaction";
import { composeApiChangePullRequest } from "../github/compose";
import { assessProviderChanges, type FindingDraft } from "../impact";
import { readJsInventory } from "../inventory/js";
import { readPythonInventory } from "../inventory/python";
import type { RepoTree } from "../inventory/tree";
import { type LiteralScan, locateLiterals } from "../locate/literals";
import { detectJsChecks } from "../verify/commands";
import { detectPyChecks } from "../verify/python-commands";
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
  providers: { provider: ProviderRecord; via: string[] }[];
  /** The change records read for those providers. */
  records: ChangeV2[];
}

/** Reads a provider's change records (worker: stored and refreshed when stale; scripts: live). */
export type ProviderChanges = (providers: ProviderRecord[]) => Promise<ChangeV2[]>;

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
      .filter((sdk) => instances.some((i) => i.ecosystem === sdk.ecosystem && i.name === sdk.name))
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

/** Every package the repo's JS and Python projects lock, for provider detection. */
export async function repoInstances(repoDir: string, tree: RepoTree) {
  return [
    ...readJsInventory(tree).flatMap((p) => p.instances),
    ...(await readPythonInventory(repoDir)).flatMap((p) => p.instances),
  ];
}

export async function assessApiChanges(
  repoDir: string,
  tree: RepoTree,
  instances: Pick<DependencyInstance, "ecosystem" | "name">[],
  changesFor: ProviderChanges,
  now = new Date(),
): Promise<ApiAssessment> {
  // First pass: URLs only, to see which API hosts the code calls.
  const hostsScan = await locateLiterals({ repoDir, tree, modelIds: new Set() });
  const hosts = new Set(hostsScan.hits.flatMap((h) => (h.host ? [h.host] : [])));
  const providers = providersUsed(instances, hosts);
  if (!providers.length) return { scan: hostsScan, findings: [], providers, records: [] };
  const records = await changesFor(providers.map((p) => p.provider));
  const scan = await locateLiterals({ repoDir, tree, modelIds: catalogModelIds(records) });
  return { scan, findings: assessProviderChanges({ records, scan, now }), providers, records };
}

/**
 * Model swaps at the located literals: every affected finding's sites whose record names exactly
 * one replacement. Several swaps on one line become one edit.
 */
export function planModelSwaps(
  repoDir: string,
  findings: FindingDraft[],
  records: ChangeV2[],
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
    for (const site of f.callSites) {
      const key = `${site.file}:${site.line}`;
      const entry = byLine.get(key) ?? { file: site.file, line: site.line, swaps: [] };
      entry.swaps.push({ column: site.column - 1, from, to: spec.to, record });
      byLine.set(key, entry);
    }
  }
  const edits: CodemodEdit[] = [];
  for (const { file, line, swaps } of byLine.values()) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, file), "utf8").split("\n")[line - 1] ?? "";
    } catch {
      continue;
    }
    let after = text;
    const applied: string[] = [];
    // Right to left, so earlier columns stay valid.
    for (const s of [...swaps].sort((a, b) => b.column - a.column)) {
      if (after.slice(s.column, s.column + s.from.length) !== s.from) continue;
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
  return edits;
}

/** The provider's own words for each change, plus its parameter changes (what a new model may reject). */
function providerNotes(group: ChangeV2[], related: ChangeV2[]): MigrationNote[] {
  const notes: MigrationNote[] = [];
  for (const r of [...group, ...related.filter((x) => x.kind === "parameter-change" && !group.includes(x))]) {
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
  return notes;
}

/** The project whose checks prove the change: the JS or Python project holding most edited files. */
async function checksFor(repoDir: string, tree: RepoTree, files: string[]) {
  const within = (root: string) => files.filter((f) => root === "." || f.startsWith(`${root}/`)).length;
  const js = readJsInventory(tree).map((p) => ({
    score: within(p.root),
    depth: p.root.length,
    plan: () => detectJsChecks(tree, p),
    project: p,
  }));
  const py = (await readPythonInventory(repoDir)).map((p) => ({
    score: within(p.root),
    depth: p.root.length,
    plan: () => detectPyChecks(tree, p),
    project: p,
  }));
  const best = [...js, ...py].sort((a, b) => b.score - a.score || b.depth - a.depth)[0];
  if (!best) throw new Error("no JavaScript or Python project to verify the change in");
  return { plan: best.plan(), project: best.project };
}

export interface FixApiInput extends Omit<FixDependencyInput, "assessment"> {
  /** One pull request's findings (one group key). */
  findings: FindingDraft[];
  /** The records those findings point at. */
  records: ChangeV2[];
  /** Every confirmed record of the same provider: parameter changes travel with a model swap. */
  related: ChangeV2[];
}

export async function fixApiChanges(
  input: FixApiInput,
): Promise<{ run: FixRun; pr: { title: string; body: string }; groupKey: string }> {
  const affected = input.findings.filter((f) => f.verdict === "affected");
  const groupKey = affected[0]?.groupKey ?? input.findings[0]?.groupKey ?? "api";
  const records = input.records.filter((r) => affected.some((f) => f.changeId === r.id));
  const edits = planModelSwaps(input.repoDir, affected, records);
  const files = [...new Set(affected.flatMap((f) => f.callSites.map((s) => s.file)))];
  const { plan, project } = await checksFor(input.repoDir, input.tree, files);
  const swaps = affected
    .filter((f) => f.position.target)
    .map((f) => `${f.position.version} → ${f.position.target}`)
    .filter((v, i, all) => all.indexOf(v) === i);
  const transaction: Transaction = {
    describe: "no package change: code edits only",
    manifest: [],
    commands: [],
    readBack: [],
  };
  const notes = providerNotes(records, input.related);
  const run = await runFix({
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
    headline: `API change: ${records.map((r) => r.title).join("; ")}. Teire swapped the model IDs where they are used as models (${swaps.join(", ")}); make the code and tests pass with the new model${swaps.length > 1 ? "s" : ""}, and check the parameter changes quoted below.`,
    edits,
    // A retired model already fails on the baseline: only passing checks prove the fix.
    requirePassing: records.some((r) => r.applicability.class === "already-broken"),
    findings: affected,
    records,
    notes,
    targetDir: input.repoDir,
    targetPaths: new Set(),
    docs: async () =>
      "Provider documentation for this change is quoted in the migration notes; there is no package to look up.",
    onEvent: input.onEvent,
  });
  const pr = composeApiChangePullRequest({
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
