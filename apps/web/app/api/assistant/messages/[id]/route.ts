import { isMessageId, ownerOf, rateMessage } from "@/lib/assistant/threads";
import { viewerOf } from "@/lib/assistant/viewer";

/** Helpful or not, on one of the person's own replies (stored with the message). */
export async function PATCH(request: Request, ctx: RouteContext<"/api/assistant/messages/[id]">) {
  const viewer = await viewerOf(request);
  const { id } = await ctx.params;
  if (!viewer || !isMessageId(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const { rating } = ((await request.json().catch(() => ({}))) ?? {}) as { rating?: unknown };
  if (rating !== 1 && rating !== -1 && rating !== null)
    return Response.json({ error: "bad request" }, { status: 400 });
  return Response.json({ ok: await rateMessage(ownerOf(viewer.userId), id, rating) });
}
