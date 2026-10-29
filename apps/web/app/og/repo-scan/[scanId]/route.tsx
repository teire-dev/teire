import { eq, repos, scans } from "@teire/db";
import { ecosystemOf, SPONSORS } from "@/lib/brands";
import { database } from "@/lib/db";
import { bucketGroups, groupFindings } from "@/lib/findings";
import type { FlowTile } from "@/lib/flow/model";
import { flowCard } from "@/lib/og/flow-card";
import { inventoryOf, scanFindings } from "@/lib/reports";

/**
 * An installed repository's scan as an image (plan revision 3.4, C12): the picture the onboarding PR
 * and the Teire Dashboard issue open with. What was read, what reaches the code and what Teire will
 * upgrade, as tiles. A private repository's image names nothing (no repository, no ecosystem logo),
 * only its counts, since anyone with the link can fetch it; never cached.
 */
export async function GET(req: Request, { params }: RouteContext<"/og/repo-scan/[scanId]">) {
  const { scanId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(scanId)) return new Response("Not found", { status: 404 });
  const [row] = await database()
    .select({ scan: scans, repo: repos })
    .from(scans)
    .innerJoin(repos, eq(repos.id, scans.repoId))
    .where(eq(scans.id, scanId))
    .limit(1);
  if (!row) return new Response("Not found", { status: 404 });
  const { scan, repo } = row;
  const open = !repo.isPrivate;
  const [findings, inventory] = await Promise.all([scanFindings(repo.id, scan.id), inventoryOf(scan.id)]);
  const b = bucketGroups(groupFindings(findings));
  const reaching = b.affected.length + b.human.length;
  const deps = inventory.reduce((n, i) => n + i.direct + (i.transitive ?? 0), 0);
  const eco = open
    ? ecosystemOf([...inventory].sort((x, y) => y.direct - x.direct)[0]?.ecosystem)
    : undefined;
  const files = (scan.coverage as { filesScanned?: number } | null)?.filesScanned;
  const upgrades = ((scan.upgrades as unknown[] | null) ?? []).length;
  const tiles: FlowTile[] = [
    {
      id: "repo",
      entity: "repository",
      state: "done",
      label: open ? (repo.fullName.split("/")[1] ?? repo.fullName) : "This repository",
      ...(open ? { brand: SPONSORS.github } : {}),
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
      id: "up",
      entity: "outcome",
      state: upgrades ? "pending" : "skipped",
      label: "Upgrades",
      meta: `${upgrades} to open`,
    },
  ];
  return flowCard({
    origin: new URL(req.url).origin,
    eyebrow: open ? `Scan · ${repo.fullName}` : "Scan",
    title: reaching
      ? `${reaching} change${reaching === 1 ? "" : "s"} reach this code`
      : "Nothing reaches this code",
    graph: {
      tiles,
      links: tiles.slice(1).map((t, i) => ({ from: tiles[i]?.id as string, to: t.id, state: t.state })),
    },
    footer: "Read at one commit. Teire fixes what reaches the code and proves it with your checks.",
  });
}
