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
  if (repo?.isPrivate) return null;
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
  return database()
    .select({
      id: publicScans.id,
      repo: publicScans.repoFullName,
      finishedAt: publicScans.finishedAt,
      // The outer row by its table name: an unqualified column would bind to `findings` itself.
      affected: sql<number>`(select count(distinct coalesce(f.group_key, f.change_id))::int from findings f
        where f.scan_id = "public_scans"."scan_id" and f.verdict = 'affected')`,
    })
    .from(publicScans)
    .where(eq(publicScans.status, "done"))
    .orderBy(desc(publicScans.finishedAt))
    .limit(limit);
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
    .select({ id: runs.id, groupKey: runs.groupKey, status: runs.status, evidenceKind: runs.evidenceKind })
    .from(runs)
    .where(
      and(
        eq(runs.repoId, repoId),
        eq(runs.kind, "dry_run"),
        sinceSha ? eq(runs.baseSha, sinceSha) : sql`true`,
      ),
    );
}
