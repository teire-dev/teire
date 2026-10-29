import { and, eq, feedback, gte, sql } from "@teire/db";
import { getChange } from "@/lib/catalog";
import { database } from "@/lib/db";
import { getSession } from "@/lib/session";

/**
 * "Wrong? Tell us" on a catalog change (plan revision 3.3, U5): stored with the change and who sent it,
 * for signed-in people, ten a day each, so a public page can't be used to flood it.
 */
const PER_DAY = 10;

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ ok: false, error: "Sign in to tell us" }, { status: 401 });
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { changeId?: unknown; reason?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (typeof body.changeId !== "string" || !reason || reason.length > 2000)
    return Response.json({ ok: false, error: "Say what's wrong (up to 2,000 characters)" }, { status: 400 });
  const record = await getChange(body.changeId);
  if (!record) return Response.json({ ok: false, error: "No such change" }, { status: 404 });
  const db = database();
  const [sent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(feedback)
    .where(
      and(eq(feedback.userId, session.user.id), gte(feedback.createdAt, sql`now() - interval '24 hours'`)),
    );
  if ((sent?.n ?? 0) >= PER_DAY)
    return Response.json(
      { ok: false, error: "That's ten reports today; thank you, more tomorrow" },
      { status: 429 },
    );
  await db.insert(feedback).values({
    changeId: record.id,
    login: session.user.name || "web",
    userId: session.user.id,
    reason,
    url: `/changes/${record.id}`,
    source: "web",
  });
  return Response.json({ ok: true });
}
