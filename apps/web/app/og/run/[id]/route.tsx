import { and, artifacts, eq, repos, runs } from "@teire/db";
import { database } from "@/lib/db";
import { type FlowGraph, proofFlow, runFlow } from "@/lib/flow/model";
import { flowCard } from "@/lib/og/flow-card";
import { proofOfRun } from "@/lib/proof";
import { runFlowsOf } from "@/lib/run-flows";

/**
 * A run's flow as an image (plan revision 3.4, V6 and C12): the link preview of `/runs/[id]` and the
 * picture a Teire PR body opens with. A public repository's run draws its own trail; a private one's
 * only its five steps' states, with no package, repository or figure, since anyone with the link can
 * fetch the image.
 */
export async function GET(req: Request, { params }: RouteContext<"/og/run/[id]">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const origin = new URL(req.url).origin;
  const db = database();
  const [row] = await db
    .select({ run: runs, repo: repos })
    .from(runs)
    .innerJoin(repos, eq(repos.id, runs.repoId))
    .where(eq(runs.id, id))
    .limit(1);
  if (!row) return new Response("Not found", { status: 404 });
  const { run, repo } = row;

  if (!repo.isPrivate && repo.installationId) {
    const input = (
      await runFlowsOf(
        { installationId: repo.installationId, account: null, publicOnly: true, userId: null },
        [id],
      )
    ).get(id);
    if (input) {
      const graph = runFlow(input);
      // Only what is known: "zod 3.25.76 → 4.1.0", or "golang.org/x/text → v0.41.0".
      const versions = run.targetVersion
        ? `${run.fromVersion ? ` ${run.fromVersion}` : ""} → ${run.targetVersion}`
        : "";
      return flowCard({
        origin,
        eyebrow: `${run.kind === "dry_run" ? "Dry run" : run.kind === "reverify" ? "Re-verify" : "Run"} · ${repo.fullName}`,
        title: `${input.subjectLabel}${versions}`,
        graph: { ...graph, tiles: graph.tiles.filter((t) => t.entity !== "repository") },
        footer: "Your own checks, before and after the change.",
      });
    }
  }

  // Private: the states alone.
  const [art] = await db
    .select({ kind: artifacts.kind, number: artifacts.number })
    .from(artifacts)
    .where(and(eq(artifacts.repoId, repo.id), eq(artifacts.runId, run.id)))
    .limit(1);
  const proof = proofOfRun({
    kind: run.kind,
    status: run.status,
    step: run.step,
    evidenceKind: run.evidenceKind,
    prMode: run.prMode,
    sites: null,
    artifact: art ? { kind: art.kind, url: null, number: null } : null,
  });
  const generic = proofFlow(proof, { subjectLabel: "The change", outcome: "pr-ready" });
  // States only, under generic names: even "issue" versus "pull request" is the repository's business.
  const NAME: Record<string, string> = {
    change: "The change",
    code: "Your code",
    fix: "Fix",
    sandbox: "Sandbox",
    check: "Your checks",
    outcome: "The outcome",
  };
  const graph: FlowGraph = {
    links: generic.links,
    tiles: generic.tiles.map(({ id: tid, entity, state }) => ({
      id: tid,
      entity,
      state,
      label: NAME[entity] ?? "A step",
    })),
  };
  return flowCard({
    origin,
    eyebrow: "A run on a private repository",
    title: "A Teire run, step by step",
    graph,
  });
}
