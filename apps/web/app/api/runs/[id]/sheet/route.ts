import { runSheet, runSheetTick } from "@/lib/run-sheet";

/**
 * The run proof sheet's live poll (U2): the run as it stands, with only the events after `after`.
 * With `diff` (the length of the diff the page holds) it is a tick: one query, the diff only when it
 * changed. The same access as the run page.
 */
export async function GET(request: Request, { params }: RouteContext<"/api/runs/[id]/sheet">) {
  const { id } = await params;
  const search = new URL(request.url).searchParams;
  const after = Number(search.get("after") ?? 0);
  const diff = Number(search.get("diff") ?? -1);
  // A tick (the page already holds the run) is one query; the first read is the whole sheet.
  const sheet =
    Number.isFinite(after) && after >= 0 && Number.isFinite(diff) && diff >= 0
      ? await runSheetTick(id, after, diff)
      : await runSheet(id, Number.isFinite(after) && after > 0 ? after : 0);
  if (!sheet) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(sheet, { headers: { "cache-control": "no-store" } });
}
