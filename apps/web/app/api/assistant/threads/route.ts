import { ownerOf, threadsOf } from "@/lib/assistant/threads";
import { viewerOf } from "@/lib/assistant/viewer";

/** The person's Ask Teire threads, newest first; `?q=` searches titles and messages. */
export async function GET(request: Request) {
  const viewer = await viewerOf(request);
  if (!viewer) return Response.json({ error: "Sign in" }, { status: 401 });
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const rows = await threadsOf(ownerOf(viewer.userId), q);
  return Response.json({ threads: rows.map((t) => ({ ...t, updatedAt: t.updatedAt.toISOString() })) });
}
