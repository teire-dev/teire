import { type ScanUpgrade, sql } from "@teire/db";
import { database } from "./db";
import type { FindingRow } from "./findings";

/**
 * The inventory's facts per dependency (revamp S3: "what's in this repo, and which of it needs me"),
 * from the database only, so a repository with thousands of transitive rows never fetches per row:
 * the latest version and how many releases behind come from the registry cache where the worker read
 * it ("—" where it didn't); advisories and findings from this repository's open findings; the planned
 * upgrade from the scan.
 */
export interface InventoryFacts {
  latest: string | null;
  behind: number | null;
}

export async function inventoryFacts(scanId: string) {
  // One pass over each cached version list: the default's position minus the installed one's.
  const { rows } = await database().execute<{ id: string; latest: string | null; behind: number | null }>(sql`
    select di.id, rc.data->>'defaultVersion' as latest, idx.behind
    from dependency_instances di
    left join registry_cache rc on rc.ecosystem = di.ecosystem and rc.name = di.name
    left join lateral (
      select (max(n) filter (where (x->>'isDefault')::boolean)
        - max(n) filter (where x->>'version' = di.version))::int as behind
      from jsonb_array_elements(rc.data->'versions') with ordinality as v(x, n)
    ) idx on true
    where di.scan_id = ${scanId}`);
  return new Map<string, InventoryFacts>(
    rows.map((r) => [
      String(r.id),
      { latest: r.latest, behind: r.behind === null ? null : Math.max(0, Number(r.behind)) },
    ]),
  );
}

const AFFECTING = new Set(["affected", "needs_human", "check_by_hand"]);

/** `npm/zod` from a package group (`npm/zod/4.6.6`) or an advisory group (`advisory/npm/zod/GHSA-…`). */
export function packageOfGroup(groupKey: string | null) {
  if (!groupKey) return null;
  const parts = groupKey.replace(/^advisory\//, "").split("/");
  return parts.length >= 3 ? `${parts[0]}/${parts.slice(1, -1).join("/")}` : null;
}

/** Open advisories and other findings per package (`eco/name`), as this repository's Findings count them. */
export function findingsByPackage(rows: FindingRow[]) {
  const out = new Map<string, { advisories: Set<string>; findings: Set<string> }>();
  for (const f of rows) {
    if (f.state !== "open" || !AFFECTING.has(f.verdict)) continue;
    const pkg = packageOfGroup(f.groupKey);
    if (!pkg) continue;
    const entry = out.get(pkg) ?? { advisories: new Set(), findings: new Set() };
    (f.kind === "security-advisory" ? entry.advisories : entry.findings).add(f.changeId);
    out.set(pkg, entry);
  }
  return new Map([...out].map(([k, v]) => [k, { advisories: v.advisories.size, findings: v.findings.size }]));
}

/** The upgrade the scan plans per package (`eco/name`): its target, and whether it fixes an advisory. */
export function plannedByPackage(upgrades: ScanUpgrade[] | null | undefined) {
  const out = new Map<string, { to: string; security: boolean }>();
  for (const u of upgrades ?? []) {
    const pkg = packageOfGroup(u.groupKey);
    if (pkg && !out.has(pkg)) out.set(pkg, { to: u.to, security: !!u.security });
  }
  return out;
}
