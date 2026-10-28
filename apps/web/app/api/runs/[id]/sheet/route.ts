import { runSheet } from "@/lib/run-sheet";

/**
 * The run proof sheet's live poll (U2): the run as it stands, with only the events after `after`.
 * The same access as the run page.
 */
export async function GET(request: Request, { params }: RouteContext<"/api/runs/[id]/sheet">) {
  const { id } = await params;
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  const sheet = await runSheet(id, Number.isFinite(after) && after > 0 ? after : 0);
  if (!sheet) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(sheet, { headers: { "cache-control": "no-store" } });
}
