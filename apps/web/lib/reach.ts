import { and, findings, inArray } from "@teire/db";
import { database } from "./db";

/** What reaches the code for one change group: located call sites (affected findings only), and
 * whether it is a security advisory (whose reach is the installed version, not a call site). */
export interface Reach {
  sites: number | null;
  advisory: boolean;
}

/**
 * Reach for many (repository, group) pairs in one query (review round 2: no query per row). Sites
 * count only findings that reach the code; a group the scan located but that reaches nothing is 0;
 * a group never located (a plain bump) is null.
 */
export async function reachOf(pairs: { repoId: number; groupKey: string | null }[]) {
  const wanted = pairs.filter((p): p is { repoId: number; groupKey: string } => !!p.groupKey);
  const out = new Map<string, Reach>();
  if (!wanted.length) return out;
  const rows = await database()
    .select({
      repoId: findings.repoId,
      groupKey: findings.groupKey,
      callSites: findings.callSites,
      verdict: findings.verdict,
      cls: findings.class,
    })
    .from(findings)
    .where(
      and(
        inArray(findings.repoId, [...new Set(wanted.map((p) => p.repoId))]),
        inArray(findings.groupKey, [...new Set(wanted.map((p) => p.groupKey))]),
      ),
    );
  for (const r of rows) {
    const key = `${r.repoId}:${r.groupKey}`;
    const reach = out.get(key) ?? { sites: null, advisory: false };
    const located = Array.isArray(r.callSites) ? (r.callSites as unknown[]).length : null;
    if (r.verdict === "affected") {
      if (r.cls === "security") reach.advisory = true;
      if (located !== null) reach.sites = (reach.sites ?? 0) + located;
    } else if (located !== null && reach.sites === null) reach.sites = 0;
    out.set(key, reach);
  }
  return out;
}

export const reachKey = (repoId: number, groupKey: string | null) => `${repoId}:${groupKey}`;
