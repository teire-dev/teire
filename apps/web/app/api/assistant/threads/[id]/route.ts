import {
  deleteThread,
  isThreadId,
  messagesOf,
  ownerOf,
  renameThread,
  threadOf,
} from "@/lib/assistant/threads";
import { viewerOf } from "@/lib/assistant/viewer";

/** One of the person's threads: its messages (GET), a new title (PATCH), or gone (DELETE). */
async function owned(request: Request, params: Promise<{ id: string }>) {
  const viewer = await viewerOf(request);
  const { id } = await params;
  if (!viewer || !isThreadId(id)) return null;
  const owner = ownerOf(viewer.userId);
  const thread = await threadOf(owner, id);
  return thread ? { owner, thread } : null;
}

export async function GET(request: Request, ctx: RouteContext<"/api/assistant/threads/[id]">) {
  const found = await owned(request, ctx.params);
  // A thread not started yet (or not this person's) reads as empty: nothing is said about anyone else's.
  if (!found) return Response.json({ thread: null, messages: [] });
  return Response.json({
    thread: { id: found.thread.id, title: found.thread.title, context: found.thread.context },
    messages: await messagesOf(found.thread.id),
  });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/assistant/threads/[id]">) {
  const found = await owned(request, ctx.params);
  if (!found) return Response.json({ error: "No such thread" }, { status: 404 });
  const { title } = ((await request.json().catch(() => ({}))) ?? {}) as { title?: unknown };
  if (typeof title !== "string") return Response.json({ error: "bad request" }, { status: 400 });
  return Response.json({ ok: await renameThread(found.owner, found.thread.id, title) });
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/assistant/threads/[id]">) {
  const found = await owned(request, ctx.params);
  if (!found) return Response.json({ error: "No such thread" }, { status: 404 });
  return Response.json({ ok: await deleteThread(found.owner, found.thread.id) });
}
