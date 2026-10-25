import {
  and,
  artifacts,
  changes,
  dependencyInstances,
  desc,
  eq,
  findings,
  inArray,
  installations,
  isNull,
  llmCalls,
  repos,
  runs,
  sandboxExecs,
  scans,
  sql,
  userInstallations,
} from "@teire/db";
import { database } from "./db";
import type { FindingRow } from "./findings";

/**
 * The signed-in dashboard (C3–C8): everything is scoped to the installations GitHub said this
 * person can see when they signed in (user_installations), so a page never shows another account's
 * repositories.
 */
export async function myInstallations(userId: string) {
  return database()
    .select({
      id: installations.id,
      login: installations.accountLogin,
      type: installations.accountType,
      avatarUrl: installations.avatarUrl,
      selection: installations.repositorySelection,
      suspendedAt: installations.suspendedAt,
    })
    .from(userInstallations)
    .innerJoin(installations, eq(installations.id, userInstallations.installationId))
    .where(and(eq(userInstallations.userId, userId), isNull(installations.deletedAt)));
}

export async function myRepos(userId: string) {
  const ids = (await myInstallations(userId)).map((i) => i.id);
  if (!ids.length) return [];
  const db = database();
  return db
    .select({
      id: repos.id,
      fullName: repos.fullName,
      status: repos.status,
      isPrivate: repos.isPrivate,
      languages: repos.languages,
      lastScannedAt: repos.lastScannedAt,
      installationId: repos.installationId,
      // Correlated subqueries name the outer row as "repos"."id": Drizzle leaves single-table
      // columns unqualified, and an unqualified "id" would bind to the subquery's own table.
      affected: sql<number>`(select count(distinct coalesce(f.group_key, f.change_id))::int from findings f
        where f.repo_id = "repos"."id" and f.verdict = 'affected' and f.state = 'open')`,
      openPrs: sql<number>`(select count(*)::int from artifacts a
        where a.repo_id = "repos"."id" and a.kind = 'pr' and a.state = 'open')`,
      dependencies: sql<number>`(select count(*)::int from dependency_instances d where d.scan_id =
        (select s.id from scans s where s.repo_id = "repos"."id" and s.status = 'done' order by s.created_at desc limit 1))`,
    })
    .from(repos)
    .where(inArray(repos.installationId, ids))
    .orderBy(repos.fullName);
}

export async function overview(userId: string) {
  const mine = await myRepos(userId);
  const ids = mine.map((r) => r.id);
  if (!ids.length) return { repos: mine, deadlines: [], runs: [], prs: [] };
  const db = database();
  const [deadlines, recent, prs] = await Promise.all([
    db
      .select({
        repo: repos.fullName,
        groupKey: findings.groupKey,
        changeId: findings.changeId,
        title: changes.title,
        deadline: changes.deadline,
        verdict: findings.verdict,
      })
      .from(findings)
      .innerJoin(changes, eq(changes.id, findings.changeId))
      .innerJoin(repos, eq(repos.id, findings.repoId))
      .where(
        and(
          inArray(findings.repoId, ids),
          eq(findings.state, "open"),
          sql`${findings.verdict} in ('affected', 'needs_human', 'check_by_hand')`,
          sql`${changes.deadline} is not null`,
        ),
      )
      .orderBy(changes.deadline)
      .limit(12),
    db
      .select({
        id: runs.id,
        repo: repos.fullName,
        groupKey: runs.groupKey,
        kind: runs.kind,
        status: runs.status,
        evidenceKind: runs.evidenceKind,
        createdAt: runs.createdAt,
        costUsd: runs.costUsd,
      })
      .from(runs)
      .innerJoin(repos, eq(repos.id, runs.repoId))
      .where(inArray(runs.repoId, ids))
      .orderBy(desc(runs.createdAt))
      .limit(10),
    db
      .select({
        repo: repos.fullName,
        number: artifacts.number,
        url: artifacts.url,
        changeKey: artifacts.changeKey,
        runId: artifacts.runId,
      })
      .from(artifacts)
      .innerJoin(repos, eq(repos.id, artifacts.repoId))
      .where(and(inArray(artifacts.repoId, ids), eq(artifacts.kind, "pr"), eq(artifacts.state, "open")))
      .orderBy(desc(artifacts.updatedAt))
      .limit(10),
  ]);
  return { repos: mine, deadlines, runs: recent, prs };
}

/** One repository the person can see, with everything its page shows. */
export async function repoDetail(userId: string, fullName: string) {
  const db = database();
  const [repo] = await db.select().from(repos).where(eq(repos.fullName, fullName)).limit(1);
  if (!repo?.installationId) return null;
  const [allowed] = await db
    .select()
    .from(userInstallations)
    .where(
      and(eq(userInstallations.userId, userId), eq(userInstallations.installationId, repo.installationId)),
    )
    .limit(1);
  if (!allowed) return null;
  const [scan] = await db
    .select()
    .from(scans)
    .where(and(eq(scans.repoId, repo.id), eq(scans.status, "done")))
    .orderBy(desc(scans.createdAt))
    .limit(1);
  const [rows, inventory, prs, recent] = await Promise.all([
    db
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
      .where(eq(findings.repoId, repo.id)) as Promise<FindingRow[]>,
    scan
      ? db
          .select()
          .from(dependencyInstances)
          .where(eq(dependencyInstances.scanId, scan.id))
          .orderBy(dependencyInstances.ecosystem, dependencyInstances.name)
      : Promise.resolve([]),
    // PRs, issues and the onboarding PR; the Dashboard issue is not a pull request.
    db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.repoId, repo.id), sql`${artifacts.kind} <> 'dashboard'`))
      .orderBy(desc(artifacts.updatedAt)),
    db.select().from(runs).where(eq(runs.repoId, repo.id)).orderBy(desc(runs.createdAt)).limit(25),
  ]);
  return { repo, scan: scan ?? null, findings: rows, inventory, artifacts: prs, runs: recent };
}

/** Totals for the settings page: runs, model tokens and cost, sandbox time, across the person's repos. */
export async function usage(userId: string) {
  const ids = (await myRepos(userId)).map((r) => r.id);
  if (!ids.length) return { runs: 0, tokens: 0, costUsd: 0, sandboxMs: 0 };
  const db = database();
  const [[r], [l], [s]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(runs).where(inArray(runs.repoId, ids)),
    db
      .select({
        tokens: sql<number>`coalesce(sum(${llmCalls.tokensIn} + ${llmCalls.tokensOut}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float`,
      })
      .from(llmCalls)
      .innerJoin(runs, eq(runs.id, llmCalls.runId))
      .where(inArray(runs.repoId, ids)),
    db
      .select({ ms: sql<number>`coalesce(sum(${sandboxExecs.durationMs}), 0)::bigint` })
      .from(sandboxExecs)
      .innerJoin(runs, eq(runs.id, sandboxExecs.runId))
      .where(inArray(runs.repoId, ids)),
  ]);
  return {
    runs: r?.n ?? 0,
    tokens: Number(l?.tokens ?? 0),
    costUsd: Number(l?.cost ?? 0),
    sandboxMs: Number(s?.ms ?? 0),
  };
}
