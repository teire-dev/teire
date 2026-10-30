import { sql } from "@teire/db";
import { myScope } from "@/lib/app-shell";
import { database } from "@/lib/db";
import { changeHref } from "@/lib/links";
import { getSession } from "@/lib/session";
import { changesFor, scopeRaw } from "@/lib/workspace";

/**
 * What the public catalog reaches in the signed-in person's own repositories (plan revision 3.3, U5),
 * under their installation's rules (private repositories only where GitHub lists them for this
 * person). Without `package`: how many repositories each change reaches ("N repos affected" on
 * /changes). With `package=<ecosystem>/<name>`: each installed copy of that package in their
 * repositories, with what applies to it (the package page). With `change=<id>`: where it reaches and what Fix now would do in each (the
 * change page's fan). Signed out, nothing.
 */
const none = { headers: { "cache-control": "private, no-store" } };
const USES_SHOWN = 60;

export async function GET(request: Request) {
  const session = await getSession();
  const mine = session ? await myScope(session.user.id) : null;
  const pkg = new URL(request.url).searchParams.get("package");
  if (!mine) return Response.json(pkg ? { uses: [] } : { reach: {}, reaches: [] }, none);
  if (pkg) {
    if (!/^[\w-]+\/[\w@./:-]{1,200}$/.test(pkg)) return Response.json({ uses: [] }, none);
    // LIKE's wildcards are escaped, not dropped: `typing_extensions` must match itself, and only itself.
    const prefix = `${pkg.replace(/[\\%_]/g, "\\$&")}/%`;
    // The package page's "Where you stand" (revamp S3): each of the person's repositories that
    // installs it, at its latest completed scan, one row per installed copy.
    const slash = pkg.indexOf("/");
    const { rows: uses } = await database().execute<{
      full_name: string;
      version: string | null;
      direct: boolean;
      manifest_path: string;
      workspace: string;
      planned_to: string | null;
      planned_security: boolean | null;
      advisories: number;
      others: number;
      api_to: string | null;
      api_counts: Record<string, number> | null;
      api_change: string | null;
    }>(sql`
      select r.full_name, di.version, di.direct, di.manifest_path, di.workspace, pu.planned_to, pu.planned_security,
        fo.advisories, fo.others, api.to_version as api_to, api.counts as api_counts, apic.id as api_change
      from dependency_instances di
      join repos r on r.id = di.repo_id
      join installations i on i.id = r.installation_id
      join lateral (select s.id, s.upgrades from scans s where s.repo_id = r.id and s.status = 'done'
        order by s.created_at desc limit 1) ls on ls.id = di.scan_id
      -- The upgrade that scan plans for this install (the plan names the version it moves from).
      left join lateral (select u->>'to' as planned_to, (u->>'security')::boolean as planned_security
        from jsonb_array_elements(coalesce(ls.upgrades, '[]'::jsonb)) u
        where u->>'groupKey' like ${prefix} and (u->>'from' is null or u->>'from' = di.version)
        limit 1) pu on true
      -- Open findings on this installed copy, as a finding names it (a transitive copy may add
      -- #<version>), so a workspace on a fixed version isn't flagged for another's advisory.
      left join lateral (select
          count(distinct f.change_id) filter (where c.kind = 'security-advisory')::int as advisories,
          count(distinct f.change_id) filter (where c.kind is distinct from 'security-advisory')::int as others
        from findings f left join changes c on c.id = f.change_id
        where f.repo_id = r.id and f.state = 'open'
          and f.verdict in ('affected', 'needs_human', 'check_by_hand')
          and f.dependency_key in (di.dependency_key, di.dependency_key || '#' || coalesce(di.version, 'unresolved'))
        ) fo on true
      -- What the API changes from the installed version to the planned one (else the latest), where
      -- Teire computed that pair, and the public change that lists it.
      left join registry_cache rc on rc.ecosystem = di.ecosystem and rc.name = di.name
      left join lateral (select sd.to_version, sd.result->'counts' as counts from surface_diffs sd
        where sd.ecosystem = di.ecosystem and sd.name = di.name and sd.from_version = di.version
          and sd.to_version = coalesce(pu.planned_to, rc.data->>'defaultVersion')
        order by sd.computed_at desc limit 1) api on true
      left join lateral (select c.id from changes c
        where c.ecosystem = di.ecosystem and c.subject_name = di.name and c.visibility = 'public'
          and c.record->'applicability'->>'fromVersion' = di.version
          and c.record->'applicability'->>'toVersion' = api.to_version
        order by (c.kind = 'symbol-removed') desc, c.id limit 1) apic on true
      where ${scopeRaw(mine.scope, "r", "i")}
        and di.ecosystem = ${pkg.slice(0, slash)} and di.name = ${pkg.slice(slash + 1)}
      order by r.full_name, di.direct desc, di.manifest_path
      limit ${USES_SHOWN}`);
    return Response.json(
      {
        uses: uses.map((u) => ({
          repo: u.full_name,
          version: u.version,
          direct: u.direct,
          manifest: u.manifest_path,
          workspace: u.workspace,
          planned: u.planned_to ? { to: u.planned_to, security: !!u.planned_security } : null,
          advisories: u.advisories ?? 0,
          others: u.others ?? 0,
          api: u.api_to
            ? {
                to: u.api_to,
                counts: u.api_counts ?? {},
                href: u.api_change ? changeHref(u.api_change) : null,
              }
            : null,
        })),
      },
      none,
    );
  }
  const changes = await changesFor(mine.scope);
  // With `change=<id>`: where that change reaches, each with what Fix now would do (the change page's fan).
  const change = new URL(request.url).searchParams.get("change");
  if (change) return Response.json({ reaches: changes.find((c) => c.id === change)?.reaches ?? [] }, none);
  const reach = Object.fromEntries(changes.map((c) => [c.id, new Set(c.reaches.map((r) => r.repo)).size]));
  return Response.json({ reach }, none);
}
