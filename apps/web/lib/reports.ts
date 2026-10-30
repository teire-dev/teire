import {
  and,
  changes,
  dependencyInstances,
  desc,
  eq,
  findings,
  gte,
  publicScans,
  repos,
  runs,
  scans,
  sql,
} from "@teire/db";
import { database } from "./db";
import type { FindingRow } from "./findings";
import { stillPublic } from "./visibility";

/** A public scan report (C9): the request, its scan, findings and inventory. Public repos only. */
export async function publicReport(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const db = database();
  const [request] = await db.select().from(publicScans).where(eq(publicScans.id, id)).limit(1);
  if (!request) return null;
  if (!request.repoId || !request.scanId)
    return { request, scan: null, repo: null, findings: [], inventory: [] };
  const [[scan], [repo]] = await Promise.all([
    db.select().from(scans).where(eq(scans.id, request.scanId)).limit(1),
    db.select().from(repos).where(eq(repos.id, request.repoId)).limit(1),
  ]);
  if (repo && !(await stillPublic(repo))) return null;
  const [rows, inventory] = await Promise.all([
    scanFindings(request.repoId, request.scanId),
    inventoryOf(request.scanId),
  ]);
  return { request, scan: scan ?? null, repo: repo ?? null, findings: rows, inventory };
}

export async function scanFindings(repoId: number, scanId: string): Promise<FindingRow[]> {
  return database()
    .select({
      id: findings.id,
      changeId: findings.changeId,
      dependencyKey: findings.dependencyKey,
      verdict: findings.verdict,
      state: findings.state,
      priority: findings.priority,
      reason: findings.reason,
      reachability: findings.reachability,
      groupKey: findings.groupKey,
      callSites: findings.callSites,
      position: findings.position,
      title: changes.title,
      kind: changes.kind,
      deadline: changes.deadline,
    })
    .from(findings)
    .leftJoin(changes, eq(changes.id, findings.changeId))
    .where(and(eq(findings.repoId, repoId), eq(findings.scanId, scanId)));
}

/** Dependencies read per ecosystem: direct and transitive. */
export async function inventoryOf(scanId: string) {
  return database()
    .select({
      ecosystem: dependencyInstances.ecosystem,
      direct: sql<number>`count(*) filter (where ${dependencyInstances.direct})::int`,
      transitive: sql<number>`count(*) filter (where not ${dependencyInstances.direct})::int`,
    })
    .from(dependencyInstances)
    .where(eq(dependencyInstances.scanId, scanId))
    .groupBy(dependencyInstances.ecosystem);
}

/** Finished public reports, newest first, for /scan. */
export async function recentReports(limit = 8) {
  const rows = await database()
    .select({
      id: publicScans.id,
      repo: publicScans.repoFullName,
      finishedAt: publicScans.finishedAt,
      repoRow: {
        id: repos.id,
        fullName: repos.fullName,
        isPrivate: repos.isPrivate,
        installationId: repos.installationId,
      },
      // The outer row by its table name: an unqualified column would bind to `findings` itself.
      affected: sql<number>`(select count(distinct coalesce(f.group_key, f.change_id))::int from findings f
        where f.scan_id = "public_scans"."scan_id" and f.verdict = 'affected')`,
    })
    .from(publicScans)
    .innerJoin(repos, eq(repos.id, publicScans.repoId))
    // A repository that is private now never shows here, even if it was public when scanned: its
    // report already answers 404, so its name must not appear in the list either.
    .where(and(eq(publicScans.status, "done"), eq(repos.isPrivate, false)))
    .orderBy(desc(publicScans.finishedAt))
    .limit(limit * 2);
  // And GitHub still says public (V7 final review), checked at most every few minutes per repository.
  const shown = [];
  for (const r of rows) {
    if (shown.length >= limit) break;
    if (await stillPublic(r.repoRow))
      shown.push({ id: r.id, repo: r.repo, finishedAt: r.finishedAt, affected: r.affected });
  }
  return shown;
}

/** How many public scans and dry runs this person started in the last 24 hours. */
export async function usageToday(userId: string) {
  const since = new Date(Date.now() - 86_400_000);
  const db = database();
  const [[s], [r]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(publicScans)
      .where(and(eq(publicScans.requestedBy, userId), gte(publicScans.createdAt, since))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.requestedBy, userId), eq(runs.kind, "dry_run"), gte(runs.createdAt, since))),
  ]);
  return { scans: s?.n ?? 0, dryRuns: r?.n ?? 0 };
}

/** Dry runs already started from this report, so its page can link them. */
export async function dryRunsFor(repoId: number, sinceSha: string | null) {
  return database()
    .select({
      id: runs.id,
      groupKey: runs.groupKey,
      status: runs.status,
      step: runs.step,
      evidenceKind: runs.evidenceKind,
      requestedBy: runs.requestedBy,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(
      and(
        eq(runs.repoId, repoId),
        eq(runs.kind, "dry_run"),
        sinceSha ? eq(runs.baseSha, sinceSha) : sql`true`,
      ),
    );
}
