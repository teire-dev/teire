import {
  type ApplicabilityClass,
  type CallSite,
  type ChangeV2,
  type Coverage,
  type DependencyInstance,
  dependencyKey,
  groupKey,
  PR_OPENING_KINDS,
  type Reachability,
  type Verdict,
} from "../contract";
import type { Hit, ImportUse, LocateResult } from "../locate/ts";

/**
 * Impact (card C3): for one dependency instance and the change records about it, decide position →
 * class → verdict with evidence (rule 2). A verdict is "not affected" only with type-level coverage
 * and no unresolved sites; "affected" only with resolved call sites. Candidate records
 * (optional→required, new required properties) count only where the repo builds that type itself.
 */
export interface FindingDraft {
  changeId: string;
  changeKind: ChangeV2["kind"];
  dependencyKey: string;
  verdict: Verdict;
  class: ApplicabilityClass;
  reachability: Reachability;
  /** Lower opens first: security with a fix 0, already broken 1, dated ≤90 days 2, majors meeting a use 3, rest 4. */
  priority: number | null;
  position: { version: string | null; target: string | null; isMajor: boolean };
  callSites: CallSite[];
  coverage: Coverage | null;
  groupKey: string | null;
  reason: string;
}

export interface ImpactInput {
  instance: DependencyInstance;
  target: string | null;
  isMajor: boolean;
  records: ChangeV2[];
  locate: LocateResult | null;
  now?: Date;
}

const DAY = 86_400_000;

export function priorityOf(record: ChangeV2, verdict: Verdict, now: Date): number | null {
  if (verdict !== "affected") return null;
  const cls = record.applicability.class;
  if (cls === "security") return record.applicability.fixedIn.length ? 0 : 4;
  if (cls === "already-broken") return 1;
  if (cls === "breaks-on-date") {
    const on = record.applicability.effectiveOn;
    return on && new Date(on).getTime() - now.getTime() <= 90 * DAY ? 2 : 4;
  }
  return PR_OPENING_KINDS.has(record.kind) ? 3 : 4;
}

/** Declaration key of the type a property belongs to: `file#Type.prop` → `file#Type`. */
function parentKey(declKey: string) {
  const hash = declKey.indexOf("#");
  const dot = declKey.lastIndexOf(".");
  return dot > hash ? declKey.slice(0, dot) : null;
}

function sitesFor(record: ChangeV2, locate: LocateResult): { sites: CallSite[]; imports: ImportUse[] } {
  const keys = new Set<string>();
  const literalChecks = new Map<string, string>();
  const importPaths = new Set<string>();
  // A removed keyword breaks only the calls that pass it.
  const callArgs = new Map<string, Set<string>>();
  for (const s of record.signatures)
    if (s.kind === "call-arg")
      for (const callee of s.callee) callArgs.set(callee, (callArgs.get(callee) ?? new Set()).add(s.arg));
  for (const s of record.signatures) {
    if (s.kind === "symbol") {
      if (record.kind === "required-added" || record.kind === "optional-to-required") {
        const parent = parentKey(s.declKey);
        if (parent) literalChecks.set(parent, s.path.slice(s.path.lastIndexOf(".") + 1));
      } else keys.add(s.declKey);
    } else if (s.kind === "import-path") importPaths.add(s.value);
  }
  const sites: CallSite[] = [];
  for (const hit of locate.hits) {
    const args = callArgs.get(hit.declKey);
    if (args) {
      if (hit.kwargs?.some((k) => args.has(k))) sites.push(strip(hit));
    } else if (keys.has(hit.declKey)) sites.push(strip(hit));
    // A literal of the changed type that leaves out the now-required property.
    const prop = literalChecks.get(hit.declKey);
    if (prop && hit.kind === "object" && !hit.props?.includes(prop)) sites.push(strip(hit));
  }
  const imports =
    record.kind === "deep-import-removed"
      ? locate.imports.filter(
          (i) => importPaths.has(i.specifier) || (i.existsBefore && i.existsAfter === false),
        )
      : [];
  for (const i of imports)
    sites.push({
      file: i.file,
      line: i.line,
      column: i.column,
      kind: "import",
      snippet: i.specifier,
      resolution: "import",
    });
  return { sites: onePerLine(sites), imports };
}

const KIND_RANK: Record<string, number> = {
  call: 0,
  new: 1,
  import: 2,
  object: 3,
  "type-ref": 4,
  property: 5,
};

/** `client.beta.chat.completions.parse(` touches three changed symbols on one line: one site, the call. */
function onePerLine(sites: CallSite[]) {
  const best = new Map<string, CallSite>();
  for (const site of sites) {
    const key = `${site.file}:${site.line}`;
    const held = best.get(key);
    if (
      !held ||
      (KIND_RANK[site.kind] ?? 9) < (KIND_RANK[held.kind] ?? 9) ||
      (site.kind === held.kind && site.column > held.column)
    )
      best.set(key, site);
  }
  return [...best.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function strip(hit: Hit): CallSite {
  const { argCount: _a, props: _p, kwargs: _k, ...site } = hit;
  return site;
}

export function assess(input: ImpactInput): FindingDraft[] {
  const { instance, target, records, locate } = input;
  const now = input.now ?? new Date();
  // A transitive package can be installed at several versions in one project (npm nests them:
  // ansi-regex 3.0.0 and 4.1.0 under one lockfile), each its own finding; a direct dependency
  // keeps one key across versions, so its finding follows it through upgrades.
  const depKey = instance.direct
    ? dependencyKey(instance)
    : `${dependencyKey(instance)}#${instance.version ?? "unresolved"}`;
  const group = target ? groupKey(instance.ecosystem, instance.name, target) : null;
  const position = { version: instance.version, target, isMajor: input.isMajor };
  return records.map((record): FindingDraft => {
    const base = {
      changeId: record.id,
      changeKind: record.kind,
      dependencyKey: depKey,
      class: record.applicability.class,
      position,
      groupKey: group,
      coverage: locate?.coverage ?? null,
    };
    if (instance.version === null)
      return {
        ...base,
        verdict: "needs_human",
        reachability: "reachability-unknown",
        priority: null,
        callSites: [],
        reason: `the installed version is unknown (${instance.unresolvedReason ?? "unresolved"})`,
      };
    const { fromVersion, affectedRange } = record.applicability;
    const pinnedTo = fromVersion ?? affectedRange;
    if (record.applicability.class === "breaks-on-upgrade" && pinnedTo && pinnedTo !== instance.version)
      return {
        ...base,
        verdict: "not_applicable",
        reachability: "package-present",
        priority: null,
        callSites: [],
        reason: `computed for ${pinnedTo}; this instance is at ${instance.version}`,
      };
    if (record.applicability.class === "security" && !record.signatures.some((s) => s.kind === "symbol")) {
      // npm/PyPI/Maven/RubyGems advisories name no function: the package at a vulnerable version is the fact (D74).
      const fixedIn = record.applicability.fixedIn;
      return {
        ...base,
        verdict: "affected",
        reachability: "package-present",
        priority: priorityOf(record, "affected", now),
        callSites: [],
        reason: `${instance.name}@${instance.version} is in the vulnerable range${fixedIn.length ? `; fixed in ${fixedIn.join(", ")}` : "; no fixed version is published"}. The advisory names no function to look for, so use cannot be ruled out.`,
      };
    }
    const searchable = record.signatures.some((s) => s.kind === "symbol" || s.kind === "import-path");
    // A major whose API surface couldn't be compared is a package upgrade, which Teire verifies:
    // the upgrade's own checks before and after decide, not a person (rule 12: never "not affected").
    if (!searchable && record.kind === "package-major")
      return {
        ...base,
        verdict: "inconclusive",
        reachability: "package-present",
        priority: null,
        callSites: [],
        reason: "its API surface could not be compared; the upgrade's sandbox check decides",
      };
    if (!searchable)
      return {
        ...base,
        verdict: record.signatures.length ? "inconclusive" : "check_by_hand",
        reachability: "package-present",
        priority: null,
        callSites: [],
        reason: record.signatures.length
          ? "signatures of this kind are located in a later stage"
          : "the change names no symbol, path or literal to search for",
      };
    if (!locate)
      return {
        ...base,
        verdict: "inconclusive",
        reachability: "reachability-unknown",
        priority: null,
        callSites: [],
        reason: "the repo's code was not analysed",
      };
    const { sites } = sitesFor(record, locate);
    if (sites.length && record.kind === "symbol-changed")
      // Type text of a used API moved (`RequestOptions<any>` → `RequestOptions`): a string comparison
      // cannot say whether that breaks this call; the sandbox check decides (D74).
      return {
        ...base,
        verdict: "inconclusive",
        reachability: "function-reachable",
        priority: null,
        callSites: sites,
        reason: `the declared type of ${sites.length} used API(s) changed; the sandbox check decides whether it breaks`,
      };
    if (sites.length) {
      const verdict: Verdict = "affected";
      return {
        ...base,
        verdict,
        reachability: "function-reachable",
        priority: priorityOf(record, verdict, now),
        callSites: sites,
        reason: `${sites.length} resolved site(s)`,
      };
    }
    const clean = locate.coverage.resolutionLevel === "type" && locate.coverage.unresolvedSites === 0;
    return {
      ...base,
      verdict: clean ? "not_affected" : "inconclusive",
      reachability: clean ? "function-not-reachable" : "reachability-unknown",
      priority: null,
      callSites: [],
      reason: clean
        ? `no use in ${locate.coverage.filesScanned} file(s), every reference resolved by type`
        : `no resolved use, but ${locate.coverage.unresolvedSites} site(s) could not be resolved` +
          (locate.coverage.resolutionLevel === "type" ? "" : " and the package's types did not resolve"),
    };
  });
}

/** Declaration keys and identifier names a set of records asks the locator for. */
export function locateTargets(records: ChangeV2[]) {
  const declKeys = new Set<string>();
  const names = new Set<string>();
  for (const record of records) {
    for (const s of record.signatures) {
      if (s.kind !== "symbol") continue;
      const last = s.path.slice(Math.max(s.path.lastIndexOf("."), s.path.lastIndexOf(":")) + 1);
      if (record.kind === "required-added" || record.kind === "optional-to-required") {
        const parent = parentKey(s.declKey);
        if (parent) declKeys.add(parent);
        const parentName = s.path.split(".").at(-2);
        if (parentName) names.add(parentName);
      } else {
        declKeys.add(s.declKey);
        names.add(last);
        // A constructor is called by its class name (`httpx.Client(…)` runs `Client.__init__`).
        if (last === "__init__" || last === "constructor") {
          const owner = s.path.split(".").at(-2);
          if (owner) names.add(owner);
        }
      }
    }
  }
  return { declKeys, names };
}

export interface DependencyVerdict {
  verdict: "affected" | "not_affected" | "inconclusive" | "needs_human";
  /** Findings that can open a PR on their own (D70). */
  breaking: FindingDraft[];
  /** Located deprecations and type drift: annotate the PR, never open one. */
  annotations: FindingDraft[];
  coverage: Coverage | null;
}

/** One answer per dependency: affected only by a located change of a PR-opening kind. */
export function summariseFindings(findings: FindingDraft[]): DependencyVerdict {
  const breaking = findings.filter((f) => f.verdict === "affected" && PR_OPENING_KINDS.has(f.changeKind));
  const annotations = findings.filter(
    (f) =>
      (f.verdict === "affected" || f.verdict === "inconclusive") &&
      !PR_OPENING_KINDS.has(f.changeKind) &&
      f.callSites.length > 0,
  );
  const coverage = findings.find((f) => f.coverage)?.coverage ?? null;
  const verdict = breaking.length
    ? "affected"
    : findings.some((f) => f.verdict === "needs_human")
      ? "needs_human"
      : findings.some((f) => f.verdict === "inconclusive" && PR_OPENING_KINDS.has(f.changeKind)) ||
          findings.some((f) => f.verdict === "check_by_hand")
        ? "inconclusive"
        : "not_affected";
  return { verdict, breaking, annotations, coverage };
}
export * from "./provider";
export * from "./triage";
