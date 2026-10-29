import { ecosystemOf, SPONSORS } from "@/lib/brands";
import { bucketGroups, groupFindings } from "@/lib/findings";
import type { FlowTile } from "@/lib/flow/model";
import { flowCard } from "@/lib/og/flow-card";
import { dryRunsFor, publicReport } from "@/lib/reports";

/**
 * A public scan report's link preview (plan revision 3.4, V6): the repository, what was read, what
 * reaches the code and the dry runs, as the report's own summary flow. Private reports are not found.
 */
export async function GET(req: Request, { params }: RouteContext<"/og/scan/[id]">) {
  const { id } = await params;
  const report = await publicReport(id);
  if (!report?.repo || !report.scan) return new Response("Not found", { status: 404 });
  const { repo, scan } = report;
  const b = bucketGroups(groupFindings(report.findings));
  const reaching = b.affected.length + b.human.length;
  const deps = report.inventory.reduce((n, i) => n + i.direct + (i.transitive ?? 0), 0);
  const top = [...report.inventory].sort((x, y) => y.direct - x.direct)[0];
  const eco = ecosystemOf(top?.ecosystem);
  const files = (scan.coverage as { filesScanned?: number } | null)?.filesScanned;
  const runs = await dryRunsFor(repo.id, scan.sha ?? null);
  const tiles: FlowTile[] = [
    {
      id: "repo",
      entity: "repository",
      state: "done",
      label: repo.fullName.split("/")[1] ?? repo.fullName,
      meta: "public",
      brand: SPONSORS.github,
    },
    {
      id: "deps",
      entity: "update",
      // No dependency rows recorded: the tile says nothing rather than "0 read".
      state: deps ? "done" : "skipped",
      label: "Dependencies",
      ...(deps ? { meta: `${deps.toLocaleString()} read` } : {}),
      ...(eco ? { brand: eco } : {}),
    },
    {
      id: "code",
      entity: "code",
      state: "done",
      label: "Your code",
      ...(files ? { meta: `${files.toLocaleString()} files` } : {}),
    },
    {
      id: "reach",
      entity: "change",
      state: reaching ? "not_proven" : "proven",
      label: reaching ? `${reaching} reaching` : "Nothing reaching",
    },
    {
      id: "dry",
      entity: "sandbox",
      state: runs.length ? "done" : "pending",
      label: "Dry runs",
      meta: String(runs.length),
    },
  ];
  return flowCard({
    origin: new URL(req.url).origin,
    eyebrow: "Scan report",
    title: reaching
      ? `${reaching} change${reaching === 1 ? "" : "s"} reach ${repo.fullName}`
      : `Nothing reaches ${repo.fullName}`,
    graph: {
      tiles,
      links: tiles.slice(1).map((t, i) => ({ from: tiles[i]?.id as string, to: t.id, state: t.state })),
    },
    footer: "A public scan: read at one commit, nothing written to GitHub.",
  });
}
