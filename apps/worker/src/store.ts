import {
  and,
  artifacts,
  changes,
  type Database,
  dependencyInstances,
  eq,
  feedback,
  findings,
  gte,
  installations,
  llmCalls,
  repos,
  runs,
  sandboxExecs,
  scans,
  sql,
} from "@teire/db";
import { sha256 } from "@teire/engine/catalog";
import type { ChangeV2, Coverage, DependencyInstance } from "@teire/engine/contract";
import type { FindingDraft } from "@teire/engine/impact";

/** Everything the worker writes, in one place, each write idempotent. */

interface InstallationPayload {
  id: number;
  account: { id: number; login: string; type: string; avatar_url?: string } | null;
  repository_selection?: string;
  suspended_at?: string | null;
}

export async function upsertInstallation(db: Database, i: InstallationPayload) {
  const values = {
    accountId: i.account?.id ?? 0,
    accountLogin: i.account?.login ?? "",
    accountType: (i.account?.type === "Organization" ? "Organization" : "User") as "User" | "Organization",
    avatarUrl: i.account?.avatar_url ?? null,
    repositorySelection: (i.repository_selection === "selected" ? "selected" : "all") as "all" | "selected",
    suspendedAt: i.suspended_at ? new Date(i.suspended_at) : null,
    deletedAt: null,
  };
  await db
    .insert(installations)
    .values({ id: i.id, ...values })
    .onConflictDoUpdate({ target: installations.id, set: values });
}

export async function markInstallation(
  db: Database,
  id: number,
  fields: { deletedAt?: Date | null; suspendedAt?: Date | null },
) {
  await db.update(installations).set(fields).where(eq(installations.id, id));
}

export async function upsertRepo(
  db: Database,
  repo: { id: number; full_name: string; private: boolean; default_branch?: string },
  installationId: number | null,
) {
  const values = {
    installationId,
    fullName: repo.full_name,
    isPrivate: repo.private,
    ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}),
  };
  await db
    .insert(repos)
    .values({ id: repo.id, defaultBranch: repo.default_branch ?? "main", ...values })
    .onConflictDoUpdate({ target: repos.id, set: values });
  const [row] = await db.select().from(repos).where(eq(repos.id, repo.id)).limit(1);
  if (!row) throw new Error(`repo ${repo.full_name} missing after upsert`);
  return row;
}

export async function getRepo(db: Database, id: number) {
  const [row] = await db.select().from(repos).where(eq(repos.id, id)).limit(1);
  return row ?? null;
}

export async function setRepo(db: Database, id: number, fields: Partial<typeof repos.$inferInsert>) {
  await db.update(repos).set(fields).where(eq(repos.id, id));
}

export async function startScan(
  db: Database,
  repoId: number,
  trigger: "install" | "push" | "command" | "manual",
) {
  const [row] = await db
    .insert(scans)
    .values({ repoId, trigger, status: "running", startedAt: new Date() })
    .returning();
  if (!row) throw new Error("scan insert failed");
  return row;
}

export async function finishScan(
  db: Database,
  id: string,
  fields: { status: "done" | "failed"; sha?: string | null; coverage?: unknown; error?: string },
) {
  await db
    .update(scans)
    .set({ ...fields, finishedAt: new Date() })
    .where(eq(scans.id, id));
}

export async function saveInstances(
  db: Database,
  scanId: string,
  repoId: number,
  instances: DependencyInstance[],
) {
  const rows = instances.map((i) => ({
    scanId,
    repoId,
    dependencyKey: `${i.ecosystem}:${i.name}@${i.workspace}`,
    ecosystem: i.ecosystem,
    name: i.name,
    aliasName: i.aliasName ?? null,
    version: i.version,
    declaredRange: i.declaredRange ?? null,
    direct: i.direct,
    scope: i.scope,
    workspace: i.workspace,
    manifestPath: i.manifestPath,
    lockfilePath: i.lockfilePath ?? null,
    source: i.source,
    sourceRef: i.sourceRef ?? null,
    resolvedBy: i.resolvedBy,
    unresolvedReason: i.unresolvedReason ?? null,
  }));
  for (let i = 0; i < rows.length; i += 500)
    await db
      .insert(dependencyInstances)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing();
}

/** Hash of what a record says, without when it was read, so an unchanged record writes nothing. */
export function changeHash(record: ChangeV2) {
  return sha256(JSON.stringify({ ...record, sources: record.sources.map(({ checkedAt: _, ...s }) => s) }));
}

export async function upsertChange(db: Database, record: ChangeV2) {
  const contentHash = changeHash(record);
  const values = {
    schemaVersion: 2,
    subjectKind: record.subject.kind,
    ecosystem: record.subject.ecosystem ?? null,
    subjectName: record.subject.name,
    providerSlug: record.subject.provider ?? null,
    kind: record.kind,
    class: record.applicability.class,
    title: record.title,
    fromVersion: record.applicability.fromVersion ?? null,
    toVersion: record.applicability.toVersion ?? null,
    deadline: record.applicability.effectiveOn ? new Date(record.applicability.effectiveOn) : null,
    status: record.status,
    visibility: record.visibility,
    contentHash,
    record,
  };
  await db
    .insert(changes)
    .values({ id: record.id, ...values })
    .onConflictDoUpdate({
      target: changes.id,
      set: values,
      setWhere: sql`${changes.contentHash} <> ${contentHash}`,
    });
  return contentHash;
}

export async function upsertFinding(
  db: Database,
  repoId: number,
  scanId: string,
  f: FindingDraft,
  hash: string,
) {
  const values = {
    scanId,
    changeHash: hash,
    verdict: f.verdict,
    class: f.class,
    priority: f.priority,
    reachability: f.reachability,
    reason: f.reason,
    position: f.position,
    callSites: f.callSites,
    coverage: f.coverage as Coverage | null,
    groupKey: f.groupKey,
    lastEvaluatedAt: new Date(),
  };
  await db
    .insert(findings)
    .values({ repoId, changeId: f.changeId, dependencyKey: f.dependencyKey, ...values })
    .onConflictDoUpdate({
      target: [findings.repoId, findings.changeId, findings.dependencyKey],
      set: values,
    });
}

export async function markFindings(
  db: Database,
  repoId: number,
  groupKey: string,
  state: "fixed" | "dismissed",
) {
  await db
    .update(findings)
    .set({ state })
    .where(and(eq(findings.repoId, repoId), eq(findings.groupKey, groupKey)));
}

/** Inserts the run unless one with this key exists (atomic enqueue); returns it either way. */
export async function claimRun(db: Database, values: typeof runs.$inferInsert) {
  const [inserted] = await db
    .insert(runs)
    .values(values)
    .onConflictDoNothing({ target: runs.idempotencyKey })
    .returning();
  if (inserted) return { run: inserted, created: true };
  const [existing] = await db
    .select()
    .from(runs)
    .where(eq(runs.idempotencyKey, values.idempotencyKey))
    .limit(1);
  if (!existing) throw new Error("run missing after conflict");
  return { run: existing, created: false };
}

export async function getRun(db: Database, id: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row ?? null;
}

export async function updateRun(db: Database, id: string, fields: Partial<typeof runs.$inferInsert>) {
  await db
    .update(runs)
    .set({ ...fields, heartbeatAt: new Date() })
    .where(eq(runs.id, id));
}

/** Appends to a run's event log; `seq` is assigned in the database so writers never collide. */
export async function appendEvent(db: Database, runId: string, step: string, type: string, payload: object) {
  await db.execute(sql`
    insert into run_events (run_id, seq, step, type, payload)
    values (${runId}, coalesce((select max(seq) from run_events where run_id = ${runId}), 0) + 1, ${step}, ${type}, ${JSON.stringify(payload)}::jsonb)
  `);
}

export async function recordLlmCall(db: Database, values: typeof llmCalls.$inferInsert) {
  await db.insert(llmCalls).values(values);
}

export async function recordSandboxExec(db: Database, values: typeof sandboxExecs.$inferInsert) {
  await db.insert(sandboxExecs).values(values);
}

export async function getArtifact(
  db: Database,
  repoId: number,
  kind: "pr" | "issue" | "dashboard" | "onboarding",
  changeKey = "",
) {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.repoId, repoId), eq(artifacts.kind, kind), eq(artifacts.changeKey, changeKey)))
    .limit(1);
  return row ?? null;
}

export async function upsertArtifact(db: Database, values: typeof artifacts.$inferInsert) {
  const set = { ...values };
  await db
    .insert(artifacts)
    .values(values)
    .onConflictDoUpdate({ target: [artifacts.repoId, artifacts.kind, artifacts.changeKey], set });
}

export async function artifactByBranch(db: Database, repoId: number, branch: string) {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.repoId, repoId), eq(artifacts.branch, branch)))
    .limit(1);
  return row ?? null;
}

/** Open Teire PRs in a repo, and how many it opened in the last hour (noise controls, D70). */
export async function prCounts(db: Database, repoId: number) {
  const open = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(artifacts)
    .where(and(eq(artifacts.repoId, repoId), eq(artifacts.kind, "pr"), eq(artifacts.state, "open")));
  const recent = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.repoId, repoId),
        eq(artifacts.kind, "pr"),
        gte(artifacts.createdAt, new Date(Date.now() - 3_600_000)),
      ),
    );
  return { open: open[0]?.n ?? 0, lastHour: recent[0]?.n ?? 0 };
}

/** A repo's findings with the change each one is about (title, kind, deadline), for the Dashboard issue. */
export async function findingsWithChanges(db: Database, repoId: number) {
  return db
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
      coverage: findings.coverage,
      position: findings.position,
      title: changes.title,
      kind: changes.kind,
      deadline: changes.deadline,
    })
    .from(findings)
    .leftJoin(changes, eq(changes.id, findings.changeId))
    .where(eq(findings.repoId, repoId));
}

export async function openArtifacts(db: Database, repoId: number) {
  return db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.repoId, repoId), eq(artifacts.state, "open")));
}

export async function artifactByNumber(db: Database, repoId: number, number: number) {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.repoId, repoId), eq(artifacts.number, number)))
    .limit(1);
  return row ?? null;
}

/** Adds or removes an `@teire ignore` target; returns the new list. */
export async function setIgnore(db: Database, repoId: number, target: string, on: boolean) {
  const repo = await getRepo(db, repoId);
  const current = new Set((repo?.ignores as string[] | null) ?? []);
  if (on) current.add(target);
  else current.delete(target);
  const ignores = [...current];
  await setRepo(db, repoId, { ignores });
  return ignores;
}

/** Findings whose change id, package or group a target names; their state changes together. */
export async function setFindingsState(
  db: Database,
  repoId: number,
  match: (f: { changeId: string; dependencyKey: string; groupKey: string | null }) => boolean,
  state: "open" | "ignored",
) {
  const rows = await db
    .select({
      id: findings.id,
      changeId: findings.changeId,
      dependencyKey: findings.dependencyKey,
      groupKey: findings.groupKey,
    })
    .from(findings)
    .where(eq(findings.repoId, repoId));
  const ids = rows.filter(match).map((r) => r.id);
  for (const id of ids) await db.update(findings).set({ state }).where(eq(findings.id, id));
  return ids.length;
}

export async function recordFeedback(db: Database, values: typeof feedback.$inferInsert) {
  await db.insert(feedback).values(values);
}

/** A run's events of one step (the CI failure a repair run starts from). */
export async function runEventsOf(db: Database, runId: string, step: string) {
  const { rows } = await db.execute<{ type: string; payload: unknown }>(sql`
    select type, payload from run_events where run_id = ${runId} and step = ${step} order by seq
  `);
  return rows;
}
