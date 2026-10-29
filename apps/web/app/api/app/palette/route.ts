import { eq, runs } from "@teire/db";
import { myScope } from "@/lib/app-shell";
import { getSession } from "@/lib/session";
import { runsOf } from "@/lib/workspace";

/**
 * ⌘K's proof chains, loaded when the palette opens (V5–V6 review: not on every page): the latest fix
 * runs of the person's installation, each with its chain; the newest per repository marks its row.
 */
const none = { headers: { "cache-control": "private, no-store" } };

export async function GET() {
  const session = await getSession();
  const mine = session ? await myScope(session.user.id) : null;
  if (!mine) return Response.json({ runs: [] }, none);
  const rows = await runsOf(mine.scope, eq(runs.kind, "fix"), 40);
  return Response.json(
    { runs: rows.map((r) => ({ id: r.id, repo: r.repo, groupKey: r.groupKey, proof: r.proof })) },
    none,
  );
}
