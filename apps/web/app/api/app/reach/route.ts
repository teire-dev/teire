import { sql } from "@teire/db";
import { myScope } from "@/lib/app-shell";
import { database } from "@/lib/db";
import { getSession } from "@/lib/session";
import { changesFor, scopeRaw } from "@/lib/workspace";

/**
 * What the public catalog reaches in the signed-in person's own repositories (plan revision 3.3, U5),
 * under their installation's rules (private repositories only where GitHub lists them for this
 * person). Without `package`: how many repositories each change reaches ("N repos affected" on
 * /changes). With `package=<ecosystem>/<name>`: which repositories that package's open findings are
 * in (the package page). With `change=<id>`: where it reaches and what Fix now would do in each (the
 * change page's fan). Signed out, nothing.
 */
const none = { headers: { "cache-control": "private, no-store" } };
const USES_SHOWN = 60;

export async function GET(request: Request) {
  const session = await getSession();
  const mine = session ? await myScope(session.user.id) : null;
  const pkg = new URL(request.url).searchParams.get("package");
  if (!mine) return Response.json(pkg ? { repos: [] } : { reach: {}, reaches: [] }, none);
  if (pkg) {
    if (!/^[\w-]+\/[\w@./:-]{1,200}$/.test(pkg)) return Response.json({ repos: [] }, none);
    const prefix = `${pkg.replace(/[%_\\]/g, "")}/%`;
    const { rows } = await database().execute<{ full_name: string; groups: number }>(sql`
      select r.full_name, count(distinct f.group_key)::int as groups
      from findings f join repos r on r.id = f.repo_id join installations i on i.id = r.installation_id
      where ${scopeRaw(mine.scope, "r", "i")} and f.group_key like ${prefix} and f.state = 'open'
        and f.verdict in ('affected', 'needs_human', 'check_by_hand')
      group by r.full_name order by r.full_name`);
    const repos = rows.map((r) => ({ repo: r.full_name, groups: r.groups }));
    if (new URL(request.url).searchParams.get("uses") !== "1") return Response.json({ repos }, none);
    // With `uses=1` (revamp S3, the package page's "Where you stand"): each of the person's
    // repositories that installs it, at its latest completed scan: version, direct or not, manifest.
    const slash = pkg.indexOf("/");
    const { rows: uses } = await database().execute<{
      full_name: string;
      version: string | null;
      direct: boolean;
      manifest_path: string;
      workspace: string;
    }>(sql`
      select r.full_name, di.version, di.direct, di.manifest_path, di.workspace
      from dependency_instances di
      join repos r on r.id = di.repo_id
      join installations i on i.id = r.installation_id
      join lateral (select s.id from scans s where s.repo_id = r.id and s.status = 'done'
        order by s.created_at desc limit 1) ls on ls.id = di.scan_id
      where ${scopeRaw(mine.scope, "r", "i")}
        and di.ecosystem = ${pkg.slice(0, slash)} and di.name = ${pkg.slice(slash + 1)}
      order by r.full_name, di.direct desc, di.manifest_path
      limit ${USES_SHOWN}`);
    return Response.json(
      {
        repos,
        uses: uses.map((u) => ({
          repo: u.full_name,
          version: u.version,
          direct: u.direct,
          manifest: u.manifest_path,
          workspace: u.workspace,
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
