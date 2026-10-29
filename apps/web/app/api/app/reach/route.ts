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
 * in (the package page). Signed out, nothing.
 */
const none = { headers: { "cache-control": "private, no-store" } };

export async function GET(request: Request) {
  const session = await getSession();
  const mine = session ? await myScope(session.user.id) : null;
  const pkg = new URL(request.url).searchParams.get("package");
  if (!mine) return Response.json(pkg ? { repos: [] } : { reach: {} }, none);
  if (pkg) {
    if (!/^[\w-]+\/[\w@./:-]{1,200}$/.test(pkg)) return Response.json({ repos: [] }, none);
    const prefix = `${pkg.replace(/[%_\\]/g, "")}/%`;
    const { rows } = await database().execute<{ full_name: string; groups: number }>(sql`
      select r.full_name, count(distinct f.group_key)::int as groups
      from findings f join repos r on r.id = f.repo_id join installations i on i.id = r.installation_id
      where ${scopeRaw(mine.scope, "r", "i")} and f.group_key like ${prefix} and f.state = 'open'
        and f.verdict in ('affected', 'needs_human', 'check_by_hand')
      group by r.full_name order by r.full_name`);
    return Response.json({ repos: rows.map((r) => ({ repo: r.full_name, groups: r.groups })) }, none);
  }
  const changes = await changesFor(mine.scope);
  const reach = Object.fromEntries(changes.map((c) => [c.id, new Set(c.reaches.map((r) => r.repo)).size]));
  return Response.json({ reach }, none);
}
