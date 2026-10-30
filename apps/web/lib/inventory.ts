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

/**
 * Open advisories and other findings per installed copy, as this repository's Findings count them.
 * A finding names its copy by dependency key (`<eco>:<name>@<workspace>`): a direct dependency keeps
 * one key across versions, and a transitive one installed at several versions adds `#<version>`
 * (engine `assess`) where its pipeline keys them apart. So a package on a fixed version in one
 * workspace isn't flagged for an advisory on another's.
 */
export function findingsByInstance(rows: FindingRow[]) {
  // dependency key → change id → whether it is an advisory
  const byKey = new Map<string, Map<string, boolean>>();
  for (const f of rows) {
    if (f.state !== "open" || !AFFECTING.has(f.verdict) || !f.dependencyKey) continue;
    const changes = byKey.get(f.dependencyKey) ?? new Map<string, boolean>();
    changes.set(f.changeId, f.kind === "security-advisory");
    byKey.set(f.dependencyKey, changes);
  }
  return (i: { dependencyKey: string; version: string | null }) => {
    const open = new Map([
      ...(byKey.get(i.dependencyKey) ?? []),
      ...(byKey.get(`${i.dependencyKey}#${i.version ?? "unresolved"}`) ?? []),
    ]);
    const advisories = [...open.values()].filter(Boolean).length;
    return { advisories, findings: open.size - advisories };
  };
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
