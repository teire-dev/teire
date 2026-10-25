import { and, asc, eq, gt, runEvents } from "@teire/db";
import { visibleRun } from "@/lib/access";
import { database } from "@/lib/db";

/** Events after `seq`, oldest first, with the run's current state; the page polls this while active. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await visibleRun(id);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0) || 0;
  const events = await database()
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, id), gt(runEvents.seq, after)))
    .orderBy(asc(runEvents.seq))
    .limit(500);
  return Response.json({
    status: row.run.status,
    step: row.run.step,
    evidence: row.run.evidenceKind,
    events: events.map((e) => ({ seq: e.seq, at: e.at, step: e.step, type: e.type, payload: e.payload })),
  });
}
