import { type CallSite, type ChangeKindV2, PR_OPENING_KINDS, type Verdict } from "@teire/engine/contract";

const opensPr = (kind: string | null | undefined) => PR_OPENING_KINDS.has(kind as ChangeKindV2);

/**
 * Findings grouped the way Teire opens PRs (one group per `groupKey`), shared by the scan report and
 * the repo page so every surface, the CLI included, reads the same.
 */
export interface FindingRow {
  id: string;
  changeId: string;
  dependencyKey: string;
  verdict: Verdict;
  state?: string;
  priority: number | null;
  reason: string | null;
  groupKey: string | null;
  callSites: unknown;
  /** How far the code reaches the change (`function-reachable`, `function-not-reachable`, …). */
  reachability?: string | null;
  position: unknown;
  title: string | null;
  kind: string | null;
  deadline: Date | string | null;
}

export interface FindingGroup {
  key: string;
  title: string;
  verdict: Verdict;
  priority: number | null;
  deadline: string | null;
  sites: CallSite[];
  reason: string | null;
  reachability: string | null;
  changeIds: string[];
  /** Findings of the same group with a weaker verdict (mentions to check, versions outside the change). */
  others: number;
  rows: FindingRow[];
}

const RANK: Record<Verdict, number> = {
  affected: 0,
  needs_human: 1,
  check_by_hand: 2,
  inconclusive: 3,
  not_affected: 4,
  not_applicable: 5,
};

const iso = (d: Date | string | null) => (d ? (typeof d === "string" ? d : d.toISOString()) : null);

export function groupFindings(rows: FindingRow[]): FindingGroup[] {
  const byKey = new Map<string, FindingRow[]>();
  for (const r of rows)
    byKey.set(r.groupKey ?? r.changeId, [...(byKey.get(r.groupKey ?? r.changeId) ?? []), r]);
  return [...byKey].map(([key, list]) => {
    // Within one verdict, a change that opens a PR (a removal, an advisory) leads, not an annotation
    // (a deprecation, a changed type), then the most urgent, then the soonest date.
    const sorted = [...list].sort(
      (a, b) =>
        RANK[a.verdict] - RANK[b.verdict] ||
        Number(opensPr(b.kind)) - Number(opensPr(a.kind)) ||
        (a.priority ?? 9) - (b.priority ?? 9) ||
        (iso(a.deadline) ?? "9999").localeCompare(iso(b.deadline) ?? "9999"),
    );
    const head = sorted[0] as FindingRow;
    // The group says what its strongest verdict says: title, deadline and sites come from those rows.
    const lead = sorted.filter((r) => r.verdict === head.verdict);
    const seen = new Set<string>();
    const sites: CallSite[] = [];
    for (const r of lead)
      for (const s of (r.callSites as CallSite[] | null) ?? [])
        if (s.kind !== "docs" && !seen.has(`${s.file}:${s.line}`)) {
          seen.add(`${s.file}:${s.line}`);
          sites.push(s);
        }
    const deadlines = lead
      .map((r) => iso(r.deadline))
      .filter((d): d is string => Boolean(d))
      .sort();
    const priorities = lead.map((r) => r.priority).filter((p): p is number => p !== null);
    const leadIds = [...new Set(lead.map((r) => r.changeId))];
    return {
      key,
      title: `${head.title ?? head.changeId}${leadIds.length > 1 ? ` and ${leadIds.length - 1} more` : ""}`,
      verdict: head.verdict,
      priority: priorities.length ? Math.min(...priorities) : null,
      deadline: deadlines[0] ?? null,
      sites,
      reason: head.reason,
      reachability: head.reachability ?? null,
      changeIds: leadIds,
      others: sorted.length - lead.length,
      rows: sorted,
    };
  });
}

/**
 * A person decides Teire's "needs a human" verdicts and an affecting advisory with no fixed version
 * (group key `advisory/…`): there is nothing to upgrade to. The Dashboard issue and the CLI agree.
 */
const needsPerson = (g: FindingGroup) =>
  g.verdict === "needs_human" ||
  g.verdict === "check_by_hand" ||
  (g.verdict === "affected" && g.key.startsWith("advisory/"));

export function bucketGroups(groups: FindingGroup[]) {
  return {
    affected: groups
      .filter((g) => g.verdict === "affected" && !needsPerson(g))
      .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9)),
    human: groups.filter(needsPerson),
    // Inconclusive is never "not affected" (rule 12): the upgrade's sandbox run decides.
    undecided: groups.filter((g) => g.verdict === "inconclusive"),
    quiet: groups.filter((g) => g.verdict === "not_affected"),
    outside: groups.filter((g) => g.verdict === "not_applicable"),
    deadlines: groups
      .filter((g) => g.deadline && g.verdict !== "not_applicable")
      .sort((a, b) => (a.deadline as string).localeCompare(b.deadline as string)),
  };
}
