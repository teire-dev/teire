import { readAction } from "@/lib/actions";
import { getSession } from "@/lib/session";

/**
 * One action as it stands now (U1): its status, what happened and what it produced. The requester or
 * a member of its installation sees it; anyone else gets a 404, as if it didn't exist.
 */
export async function GET(_request: Request, { params }: RouteContext<"/api/actions/[id]">) {
  const session = await getSession();
  if (!session) return Response.json({ error: "sign in" }, { status: 401 });
  const { id } = await params;
  const action = await readAction(session.user.id, id);
  if (!action) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(
    {
      id: action.id,
      kind: action.kind,
      params: action.params,
      status: action.status,
      result: action.result,
      links: action.links,
      updatedAt: action.updatedAt,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
