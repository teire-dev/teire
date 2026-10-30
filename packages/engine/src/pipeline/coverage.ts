import type { AdvisoryCoverage } from "../advisories";
import type { DependencyInstance } from "../contract";
import type { TargetDecision } from "../registry/target";

/**
 * What a scan could not check, so "nothing found" is never read as "all checked" (D96): advisory
 * lookups that were partial or failed, packages whose registry did not answer, and parts of an
 * inventory the reader does not cover. Each pipeline writes into the scan's one collector.
 */
export interface ScanCoverage {
  advisories: {
    ecosystem: string;
    root: string;
    status: AdvisoryCoverage["status"];
    notes: string[];
    /** A limit of what Teire reads (Maven's transitive tree), the same on every scan, not a source that failed. */
    structural?: true;
  }[];
  lookupsFailed: { ecosystem: string; name: string }[];
  notes: string[];
  /**
   * Ecosystems Teire can't upgrade (rule 8): their packages and OSV advisories are reported, never
   * "clean". `advisories` is null when OSV didn't answer.
   */
  detectOnly: {
    ecosystem: string;
    packages: number;
    advisories: { name: string; version: string; ids: string[] }[] | null;
  }[];
  /** Direct dependencies with no version comparison, and why (S18.4): a git source, a patch, no version. */
  notCompared?: { ecosystem: string; name: string; reason: string }[];
  /** Upgrades found but held, and why: a patch to remake, a parent that manages it, a pin. */
  held?: { ecosystem: string; name: string; reason: string }[];
}

export function newScanCoverage(): ScanCoverage {
  return { advisories: [], lookupsFailed: [], notes: [], detectOnly: [] };
}

const SOURCE_REASON: Record<string, string> = {
  git: "a git source: Teire compares registry versions",
  path: "a local path",
  "private-index": "a private registry Teire has no access to",
};

/**
 * What a scan said nothing about otherwise (S18.4, rule 12): each direct dependency it didn't
 * compare and each upgrade it held, with the reason. A failed lookup is reported on its own.
 */
export function outcomesOf(
  projects: { instances: DependencyInstance[] }[],
  assessments: { instance: DependencyInstance; decision: TargetDecision | null }[],
  coverage: ScanCoverage,
) {
  const key = (i: { ecosystem: string; name: string }) => `${i.ecosystem}:${i.name}`;
  const failed = new Set(coverage.lookupsFailed.map(key));
  const decided = new Map(assessments.filter((a) => a.decision).map((a) => [key(a.instance), a.decision]));
  const notCompared = new Map<string, { ecosystem: string; name: string; reason: string }>();
  for (const i of projects.flatMap((p) => p.instances)) {
    if (!i.direct || i.source === "workspace" || decided.has(key(i)) || failed.has(key(i))) continue;
    const reason =
      i.source !== "registry"
        ? `${SOURCE_REASON[i.source] ?? i.unresolvedReason ?? "its source isn't a registry"}${i.sourceRef && i.source !== "unknown" ? ` (${i.sourceRef})` : ""}`
        : i.version === null
          ? (i.unresolvedReason ?? "no version stated")
          : null;
    if (reason && !notCompared.has(key(i)))
      notCompared.set(key(i), { ecosystem: i.ecosystem, name: i.name, reason });
  }
  const held = new Map<string, { ecosystem: string; name: string; reason: string }>();
  for (const a of assessments)
    if (a.decision?.kind === "blocked" && !held.has(key(a.instance)))
      held.set(key(a.instance), {
        ecosystem: a.instance.ecosystem,
        name: a.instance.name,
        reason: a.decision.reason,
      });
  coverage.notCompared = [...notCompared.values()];
  coverage.held = [...held.values()];
}

const listed = (items: { name: string; reason: string }[]) =>
  `${items
    .slice(0, 8)
    .map((i) => `\`${i.name}\` (${i.reason.length > 140 ? `${i.reason.slice(0, 139)}…` : i.reason})`)
    .join("; ")}${items.length > 8 ? `; and ${items.length - 8} more` : ""}`;

/** The scan's overall advisory status: the worst of its lookups (no lookup ran → "complete"). */
export function advisoryStatus(c: ScanCoverage): AdvisoryCoverage["status"] {
  const statuses = c.advisories.map((a) => a.status);
  return statuses.includes("unavailable")
    ? "unavailable"
    : statuses.includes("partial")
      ? "partial"
      : "complete";
}

/** Plain lines for the onboarding PR, the Dashboard issue and PRs; empty when everything was checked. */
/** Every source answered this time: what is missing from the scan is gone, not unchecked. */
export function lookupsAnswered(c: ScanCoverage) {
  return !c.lookupsFailed.length && c.advisories.every((a) => a.status === "complete" || a.structural);
}

export function coverageLines(c: ScanCoverage): string[] {
  const out: string[] = [];
  for (const a of c.advisories.filter((x) => x.status !== "complete"))
    out.push(
      a.status === "unavailable"
        ? `Security advisories for ${a.ecosystem}${a.root && a.root !== "." ? ` in \`${a.root}\`` : ""} could not be checked (${a.notes.join("; ")}). This is not the same as "no advisories".`
        : `Security advisories for ${a.ecosystem}${a.root && a.root !== "." ? ` in \`${a.root}\`` : ""} were checked in part: ${a.notes.slice(0, 3).join("; ")}${a.notes.length > 3 ? `; and ${a.notes.length - 3} more` : ""}.`,
    );
  if (c.lookupsFailed.length) {
    const names = [...new Set(c.lookupsFailed.map((l) => `${l.ecosystem}:${l.name}`))];
    out.push(
      `${names.length} package${names.length === 1 ? "" : "s"} could not be looked up in ${names.length === 1 ? "its" : "their"} registry, so newer versions are unknown, not "up to date": ${names
        .slice(0, 8)
        .map((n) => `\`${n}\``)
        .join(", ")}${names.length > 8 ? ` and ${names.length - 8} more` : ""}.`,
    );
  }
  for (const d of c.detectOnly)
    out.push(
      `${d.packages} ${d.ecosystem} package${d.packages === 1 ? "" : "s"}: Teire reports ${d.packages === 1 ? "it" : "them"} but doesn't upgrade ${d.ecosystem} yet. ${
        d.advisories === null
          ? "Advisories could not be checked (OSV did not answer)."
          : d.advisories.length
            ? `Advisories: ${d.advisories
                .slice(0, 6)
                .map((a) => `\`${a.name}@${a.version}\` (${a.ids.slice(0, 3).join(", ")})`)
                .join(", ")}${d.advisories.length > 6 ? ` and ${d.advisories.length - 6} more` : ""}.`
            : "No advisory matches the locked versions."
      }`,
    );
  if (c.notCompared?.length)
    out.push(
      `${c.notCompared.length} direct ${c.notCompared.length === 1 ? "dependency was" : "dependencies were"} not compared: ${listed(c.notCompared)}.`,
    );
  if (c.held?.length)
    out.push(`${c.held.length} upgrade${c.held.length === 1 ? " is" : "s are"} held: ${listed(c.held)}.`);
  out.push(...new Set(c.notes));
  return out;
}
