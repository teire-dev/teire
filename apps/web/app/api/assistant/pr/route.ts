import { and, artifacts, eq, sql } from "@teire/db";
import { readableRepo, viewerOf } from "@/lib/assistant/viewer";
import { database } from "@/lib/db";

/**
 * A pull request link pasted into Ask Teire, checked as it's typed (plan revision 3.3, U4): whether
 * its repository is one Teire watches for this person, and whether the PR is Teire's own.
 */
export async function GET(request: Request) {
  const viewer = await viewerOf(request);
  const url = new URL(request.url).searchParams.get("url") ?? "";
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d{1,9})/.exec(url);
  if (!viewer || !m) return Response.json({ state: "invalid" });
  const [, name = "", , num = "0"] = m;
  const got = await readableRepo(viewer, name);
  if ("error" in got) return Response.json({ state: "unwatched", repo: name });
  const [row] = await database()
    .select({ kind: artifacts.kind, state: artifacts.state, number: artifacts.number })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.repoId, got.repo.id),
        eq(artifacts.number, Number(num)),
        sql`${artifacts.kind} in ('pr', 'issue', 'config')`,
      ),
    )
    .limit(1);
  return Response.json(
    row
      ? { state: "teire", repo: got.repo.fullName, number: row.number, kind: row.kind, prState: row.state }
      : { state: "other", repo: got.repo.fullName, number: Number(num) },
  );
}
