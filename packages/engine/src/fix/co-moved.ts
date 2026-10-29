import { FIX } from "../constants";
import type { FindingDraft } from "../impact";
import type { CoMovedUsage, Transaction } from "./transaction";

type Moved = NonNullable<Transaction["moved"]>[number];

const numbers = (v: string) =>
  v
    .replace(/^v/, "")
    .split(/[.+-]/)
    .map((p) => Number.parseInt(p, 10));

/**
 * How far a version moved: 3 for a breaking jump (a major, or a minor below 1.0 where semver lets
 * minors break), 2 for a minor, 1 for anything smaller. Unreadable versions count as breaking: the
 * diff decides.
 */
export function jumpRank(from: string, to: string): number {
  const [a0, a1] = numbers(from);
  const [b0, b1] = numbers(to);
  if (a0 === undefined || b0 === undefined || Number.isNaN(a0) || Number.isNaN(b0)) return 3;
  if (a0 !== b0) return 3;
  if (a1 !== b1) return a0 === 0 ? 3 : 2;
  return 1;
}

/**
 * The co-upgrades worth diffing (D-10): every package the updater moved besides the lead, with both
 * versions known and different, largest jumps first; past the cap, listed but not diffed.
 */
export function coMovedToDiff(
  moved: readonly Moved[],
  lead: string,
  max = FIX.maxCoMovedDiffed,
): { diff: Moved[]; capped: Moved[] } {
  // A move with no `from` (the updater didn't say) is still diffed: the inventory has the installed
  // version (D-7); unknown jumps rank as breaking.
  const changed = moved.filter((m) => m.name !== lead && !m.removed && m.to && m.from !== m.to) as (Moved & {
    to: string;
  })[];
  const rank = (m: Moved & { to: string }) => (m.from ? jumpRank(m.from, m.to) : 3);
  const ranked = [...changed].sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
  return { diff: ranked.slice(0, max), capped: ranked.slice(max) };
}

/**
 * A moved package's findings as the agent and the PR read them: each says which package moved, and
 * with what, so a site in `http` isn't mistaken for one in `reqwest`.
 */
export function coMovedFindings(
  m: { name: string; from: string; to: string },
  lead: string,
  findings: readonly FindingDraft[],
): FindingDraft[] {
  const via = `${m.name} ${m.from} → ${m.to}, moved with ${lead}`;
  return findings.map((f) => ({ ...f, via, reason: `${via}: ${f.reason}` }));
}

/** What the PR's "Your code" column says for one moved package. */
export function usageOf(breaking: readonly FindingDraft[]): CoMovedUsage {
  return {
    diffed: true,
    breaking: breaking.length,
    sites: breaking.reduce((n, f) => n + f.callSites.length, 0),
  };
}

/** The "Your code" cell. */
export function usageCell(u: CoMovedUsage | undefined): string {
  if (!u) return "not diffed";
  if (!u.diffed) return u.note ?? "not diffed";
  if (!u.breaking) return "no breaking change it uses";
  return `${u.breaking} breaking change${u.breaking === 1 ? "" : "s"} at ${u.sites} site${u.sites === 1 ? "" : "s"}`;
}

/** The moved list with each package's usage attached (the lead and unlisted packages unchanged). */
export function withUsage(moved: readonly Moved[], usage: ReadonlyMap<string, CoMovedUsage>): Moved[] {
  return moved.map((m) => {
    const u = usage.get(m.name);
    return u ? { ...m, yourCode: u } : m;
  });
}
