import {
  actions,
  and,
  artifacts,
  changes,
  dependencyInstances,
  desc,
  eq,
  findings,
  installations,
  isNull,
  providers,
  repoProviders,
  repos,
  runs,
  scans,
  sql,
  userInstallations,
  userRepos,
} from "@teire/db";
import { cache } from "react";
import { database } from "./db";
import type { FindingRow } from "./findings";
import { repoFixMode } from "./fix-mode";

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
      defaultFixMode: installations.defaultFixMode,
      securityFixMode: installations.securityFixMode,
      createdAt: installations.createdAt,
    })
    .from(userInstallations)
    .innerJoin(installations, eq(installations.id, userInstallations.installationId))
    .where(and(eq(userInstallations.userId, userId), isNull(installations.deletedAt)));
}

/** One request reads a repository once, however many parts of the page ask (layout and tab). */
export const repoDetailCached = cache((userId: string, fullName: string) => repoDetail(userId, fullName));

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
  // A private repository needs the person's own access to it, not only to its installation (U3 review).
  if (repo.isPrivate) {
    const [own] = await db
      .select({ id: userRepos.repoId })
      .from(userRepos)
      .where(and(eq(userRepos.userId, userId), eq(userRepos.repoId, repo.id)))
      .limit(1);
    if (!own) return null;
  }
  const [[scan], [latestScan]] = await Promise.all([
    db
      .select()
      .from(scans)
      .where(and(eq(scans.repoId, repo.id), eq(scans.status, "done")))
      .orderBy(desc(scans.createdAt))
      .limit(1),
    // The latest scan whatever its outcome: a failed one is said, not hidden behind the last good one.
    db
      .select({ status: scans.status, error: scans.error, createdAt: scans.createdAt })
      .from(scans)
      .where(eq(scans.repoId, repo.id))
      .orderBy(desc(scans.createdAt))
      .limit(1),
  ]);
  const [rows, inventory, prs, recent, groupRuns] = await Promise.all([
    db
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
        source: sql`${changes.record}->'sources'->0`,
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
    // Each change's own latest run and every run waiting or going, however many the repository has:
    // past the 25 above, a queued finding read "Fix now" though its run was already waiting.
    db.execute<{ id: string }>(sql`
      select id from (
        select distinct on (group_key) id from runs
        where repo_id = ${repo.id} and group_key is not null
        order by group_key, created_at desc
      ) latest
      union
      select id from runs where repo_id = ${repo.id} and status in ('queued', 'running', 'stopping')
    `),
  ]);
  const [[inst], activity, providerRows] = await Promise.all([
    db
      .select({
        defaultFixMode: installations.defaultFixMode,
        securityFixMode: installations.securityFixMode,
        suspendedAt: installations.suspendedAt,
      })
      .from(installations)
      .where(eq(installations.id, repo.installationId))
      .limit(1),
    // Every action on the repository, from the web, comments and the Dashboard issue (U1).
    db.select().from(actions).where(eq(actions.repoId, repo.id)).orderBy(desc(actions.createdAt)).limit(40),
    // The APIs and model providers the repository calls (S20), from its latest scans.
    db
      .select({ slug: repoProviders.providerSlug, name: providers.name, seenAt: repoProviders.seenAt })
      .from(repoProviders)
      .leftJoin(providers, eq(providers.slug, repoProviders.providerSlug))
      .where(eq(repoProviders.repoId, repo.id))
      .orderBy(repoProviders.providerSlug),
  ]);
  return {
    activity,
    providers: providerRows,
    repo,
    scan: scan ?? null,
    latestScan: latestScan ?? null,
    suspended: !!inst?.suspendedAt,
    findings: rows,
    inventory,
    artifacts: prs,
    runs: recent,
    groupRunIds: groupRuns.rows.map((r) => r.id),
    // The effective fix mode and where it was set (D118), as the worker reads it.
    fixMode: repoFixMode(repo, inst ?? null),
  };
}
