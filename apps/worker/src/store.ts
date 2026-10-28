import { hostname } from "node:os";
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
  inArray,
  installations,
  isNull,
  llmCalls,
  ne,
  or,
  repos,
  runs,
  sandboxExecs,
  scans,
  sql,
} from "@teire/db";
import { sha256 } from "@teire/engine/catalog";
import { type ChangeV2, type Coverage, type DependencyInstance, lineageKey } from "@teire/engine/contract";
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
  trigger: "install" | "push" | "command" | "manual" | "catalog" | "public",
  requestedBy?: string,
) {
  const [row] = await db
    .insert(scans)
    .values({
      repoId,
      trigger,
      status: "running",
      startedAt: new Date(),
      ...(requestedBy ? { requestedBy } : {}),
    })
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
    lineageKey: f.groupKey
      ? lineageKey(f.groupKey, f.changeKind === "security-advisory" ? "security" : "version")
      : null,
    lastEvaluatedAt: new Date(),
  };
  await db
    .insert(findings)
    .values({ repoId, changeId: f.changeId, dependencyKey: f.dependencyKey, ...values })
    .onConflictDoUpdate({
      target: [findings.repoId, findings.changeId, findings.dependencyKey],
      // A finding a scan reports again is open again; ignored, fixed and dismissed stay as people left them.
      set: {
        ...values,
        state: sql`case when ${findings.state} = 'gone' then 'open' else ${findings.state} end`,
      },
    });
}

/**
 * After a complete scan, open findings it did not report again are `gone`: the dependency moved or
 * was removed, or a newer target superseded them. Never after a partial scan: a lookup that failed
 * would read as "no longer affected" (D96).
 */
export async function retireUnreported(db: Database, repoId: number, scanId: string) {
  const rows = await db
    .update(findings)
    .set({ state: "gone" })
    .where(
      and(
        eq(findings.repoId, repoId),
        eq(findings.state, "open"),
        or(isNull(findings.scanId), ne(findings.scanId, scanId)),
      ),
    )
    .returning({ id: findings.id });
  return rows.length;
}

/**
 * Whether a run for this exact target settled elsewhere recently: its target moved (a D103 cap or a
 * security floor), it fell back a major (D71), or it ended in a named stop. A new commit then doesn't
 * re-run it from scratch for the same answer; after `days` it is asked again.
 */
export async function recentlySettled(db: Database, repoId: number, groupKey: string, days = 7) {
  const { rows } = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from runs
    where repo_id = ${repoId} and kind = 'fix'
      and idempotency_key like ${`fix:${repoId}:${groupKey}:%`}
      and created_at > now() - make_interval(days => ${days})
      and (group_key <> ${groupKey} or step like 'fell back%' or error like 'stopped:%'
        or step in ('nothing to change', 'no longer applies'))
  `);
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * A fix run for this group is queued or running. A scan of a newer commit leaves it be: without
 * this, every push would queue the group a second time (the run key carries the commit).
 */
export async function fixInFlight(db: Database, repoId: number, groupKey: string) {
  const [run] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.repoId, repoId),
        eq(runs.kind, "fix"),
        eq(runs.groupKey, groupKey),
        inArray(runs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return run ?? null;
}

/** Lineages with an open finding: what an open Teire PR in that lineage still answers (C6). */
export async function openLineages(db: Database, repoId: number) {
  const rows = await db
    .select({ lineageKey: findings.lineageKey, groupKey: findings.groupKey, changeId: findings.changeId })
    .from(findings)
    .where(and(eq(findings.repoId, repoId), eq(findings.state, "open")));
  return new Set(rows.map((r) => r.lineageKey ?? lineageKey(r.groupKey ?? r.changeId)));
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

/** This process, as the holder of the runs it works on (review R13). */
export const WORKER_ID = `${hostname()}:${process.pid}:${Date.now().toString(36)}`;

/**
 * Takes the run for this worker unless another worker is working it now (a fresh heartbeat on a
 * running run): during a deploy the old and new containers overlap, and the boot sweep retries jobs
 * the old one still holds, so without this one run could open sandboxes and push twice.
 */
export async function claimRunLease(db: Database, runId: string, leaseMs: number) {
  const { rows } = await db.execute<{ id: string }>(sql`
    update runs set worker_id = ${WORKER_ID}, heartbeat_at = now()
    where id = ${runId}
      and (status <> 'running' or worker_id is null or worker_id = ${WORKER_ID}
        or heartbeat_at is null or heartbeat_at < now() - make_interval(secs => ${leaseMs / 1000}))
    returning id
  `);
  return rows.length > 0;
}

/** Renews this worker's lease; false when another worker has taken the run (this one must stop). */
export async function renewLease(db: Database, runId: string) {
  const { rows } = await db.execute<{ id: string }>(sql`
    update runs set heartbeat_at = now() where id = ${runId} and worker_id = ${WORKER_ID} returning id
  `);
  return rows.length > 0;
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
  // The baseline and after sandboxes report at the same time; without a per-run lock two inserts
  // can read the same max(seq) and the second fails on the primary key, taking the run down.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
    await tx.execute(sql`
      insert into run_events (run_id, seq, step, type, payload)
      values (${runId}, coalesce((select max(seq) from run_events where run_id = ${runId}), 0) + 1, ${step}, ${type}, ${JSON.stringify(payload)}::jsonb)
    `);
  });
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

/**
 * Uninstall (card C1, D109): queued and running work stops and the repositories' data is removed:
 * findings, inventories, scans, artifacts, feedback, snapshots, and every run with its events,
 * model calls and sandbox executions. Public dry runs stay (they are public pages). The repo rows
 * remain, disabled, so a later install starts clean.
 */
export async function removeInstallationData(db: Database, installationId: number) {
  await db.transaction(async (tx) => {
    const ids = sql`(select id from repos where installation_id = ${installationId})`;
    const runIds = sql`(select id from runs where repo_id in ${ids} and kind <> 'dry_run')`;
    await tx.execute(sql`delete from run_events where run_id in ${runIds}`);
    await tx.execute(sql`delete from llm_calls where run_id in ${runIds}`);
    await tx.execute(sql`delete from sandbox_execs where run_id in ${runIds}`);
    await tx.execute(sql`delete from runs where repo_id in ${ids} and kind <> 'dry_run'`);
    for (const table of [
      "findings",
      "dependency_instances",
      "scans",
      "artifacts",
      "feedback",
      "sandbox_snapshots",
      // Which providers the repo used: the fan-out must not rescan a repo that left (D95).
      "repo_providers",
    ])
      await tx.execute(sql`delete from ${sql.identifier(table)} where repo_id in ${ids}`);
    await tx.execute(sql`
      update repos set status = 'disabled', installation_id = null, config = null, config_source = null,
        ignores = '[]'::jsonb, last_scanned_sha = null, last_scanned_at = null, paused_from = null,
        paused_reason = null, fixes_paused = false, updated_at = now()
      where installation_id = ${installationId}
    `);
  });
}

/** Suspend pauses every repo of the installation (D109); unsuspend restores what it paused. */
export async function setInstallationPaused(db: Database, installationId: number, paused: boolean) {
  await db.execute(
    paused
      ? sql`update repos set paused_from = status, status = 'paused', paused_reason = 'installation_suspended', updated_at = now()
            where installation_id = ${installationId} and status <> 'paused' and status <> 'disabled'`
      : sql`update repos set status = coalesce(paused_from, 'active'), paused_from = null, paused_reason = null, updated_at = now()
            where installation_id = ${installationId} and paused_reason = 'installation_suspended'`,
  );
}

/** The providers a repo's code used at its last scan (D95), replacing the previous set. */
export async function setRepoProviders(db: Database, repoId: number, slugs: string[]) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from repo_providers where repo_id = ${repoId}`);
    for (const slug of new Set(slugs))
      await tx.execute(sql`insert into repo_providers (repo_id, provider_slug) values (${repoId}, ${slug})`);
  });
}
