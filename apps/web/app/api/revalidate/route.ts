import { timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";

/**
 * The worker calls this after it writes catalog or repo data, so cached pages refresh by tag
 * (Cache Components, plan D31). Bearer secret shared with the worker only.
 */
export async function POST(request: Request) {
  const secret = process.env.REVALIDATE_SECRET;
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret)))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const { tags } = (await request.json().catch(() => ({}))) as { tags?: unknown };
  const list = Array.isArray(tags)
    ? tags.filter((t): t is string => typeof t === "string" && t.length <= 200)
    : [];
  for (const tag of list) revalidateTag(tag, "max");
  return Response.json({ revalidated: list });
}
