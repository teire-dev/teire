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
  /** The change's first source (`changes.record.sources[0]`): its words, link and trust basis. */
  source?: unknown;
}

/** A change's lead source as a finding shows it: the words, where they're from, and how far to trust them. */
export interface GroupSource {
  quote: string | null;
  url: string | null;
  basis: string | null;
}

const QUOTE_CHARS = 400;

function sourceOf(raw: unknown): GroupSource | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const quote = typeof s.quote === "string" && s.quote.trim() ? s.quote.trim().slice(0, QUOTE_CHARS) : null;
  const url = typeof s.url === "string" && s.url.startsWith("https://") ? s.url : null;
  return quote || url ? { quote, url, basis: typeof s.trustBasis === "string" ? s.trustBasis : null } : null;
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
  /** What changed upstream, in its source's words, for the group's lead change. */
  source: GroupSource | null;
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
      source: lead.map((r) => sourceOf(r.source)).find(Boolean) ?? null,
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
