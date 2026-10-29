import { createHash } from "node:crypto";
import {
  and,
  artifacts,
  asc,
  desc,
  eq,
  gt,
  llmCalls,
  or,
  publicScans,
  runEvents,
  sandboxExecs,
  sql,
  userInstallations,
  userRepos,
  webhookDeliveries,
} from "@teire/db";
import { maskSecrets } from "@teire/engine/redact";
import { headers } from "next/headers";
import { visibleRun } from "./access";
import { auth } from "./auth";
import { database } from "./db";
import { reachKey, reachOf } from "./reach";
import { getSession } from "./session";

/**
 * The run proof sheet's data (plan revision 3.3, U2): one serialisable view of a run for its first
 * render and for the live poll, which asks only for the events after the last one it has. Access is
 * the run page's: anyone for a public repository, members of the installation for a private one.
 */
export interface SheetCheck {
  name: string;
  exitCode: number;
  timedOut?: boolean;
  ms?: number;
  counts?: { collected: number; passed: number; failed: number; skipped?: number } | null;
  output?: string;
  argv?: string[];
}

export interface SheetOther {
  root: string;
  ecosystem: string;
  evidence: string;
  reasons: string[];
  baseline: SheetCheck[];
  after: SheetCheck[];
}

export interface RunSheetData {
  run: {
    id: string;
    kind: string;
    status: string;
    step: string | null;
    groupKey: string | null;
    fromVersion: string | null;
    targetVersion: string | null;
    evidenceKind: string | null;
    prMode: string | null;
    backend: string | null;
    error: string | null;
    costUsd: string;
    diff: string | null;
    /** The diff's MD5, echoed by the poll so a tick sends the diff only when it changed. */
    diffHash: string;
    cancelledBy: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
  };
  repo: { fullName: string; isPrivate: boolean };
  /** `runId`: the run whose evidence the PR carries now (a re-verify takes it over). */
  artifact: {
    kind: string;
    number: number | null;
    url: string | null;
    state: string;
    runId: string | null;
  } | null;
  verification: {
    baseline?: SheetCheck[];
    after?: SheetCheck[];
    reasons?: string[];
    others?: SheetOther[];
  } | null;
  events: { seq: number; at: string; step: string; type: string; payload: unknown }[];
  execs: {
    id: string;
    phase: string;
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number | null;
    backend: string;
    stdoutTail: string | null;
    createdAt: string;
  }[];
  calls: {
    id: string;
    purpose: string;
    step: string | null;
    model: string;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number | null;
    costUsd: string;
    createdAt: string;
  }[];
  reach: { sites: number | null; advisory: boolean };
  /** A dry run's PR as GitHub would show it. */
  preview: { title?: string; body?: string; mode?: string } | null;
  /** The public report a dry run came from. */
  report: string | null;
  /** Whether the person can act on the run (a member of its installation; the worker checks write access). */
  member: boolean;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * What a run page shows, with credentials masked (U2 review): a public repository's run is open to
 * anyone, and command output can print a token. Output, reasons, events and errors all pass here.
 */
function masked<T>(value: T): T {
  if (typeof value === "string") return maskSecrets(value) as T;
  if (Array.isArray(value)) return value.map(masked) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, masked(v)])) as T;
  return value;
}

export async function runSheet(id: string, after = 0): Promise<RunSheetData | null> {
  const row = await visibleRun(id);
  if (!row) return null;
  const { run, repo } = row;
  const db = database();
  const dry = run.kind === "dry_run";
  const [[artifact], events, execs, calls, reach, [preview], [report], session] = await Promise.all([
    // The run's own PR or issue. A PR's link moves to its newest run (a re-verify), so a re-verify
    // and the run that opened the PR both find it by the group it answers.
    db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.repoId, repo.id),
          !dry && run.groupKey && (run.kind === "reverify" || run.status === "succeeded")
            ? or(
                eq(artifacts.runId, run.id),
                and(eq(artifacts.kind, "pr"), eq(artifacts.changeKey, run.groupKey)),
              )
            : eq(artifacts.runId, run.id),
        ),
      )
      .orderBy(sql`${artifacts.runId} = ${run.id} desc`, sql`${artifacts.kind} = 'pr' desc`)
      .limit(1),
    db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), gt(runEvents.seq, after)))
      .orderBy(asc(runEvents.seq)),
    db.select().from(sandboxExecs).where(eq(sandboxExecs.runId, run.id)).orderBy(asc(sandboxExecs.createdAt)),
    db.select().from(llmCalls).where(eq(llmCalls.runId, run.id)).orderBy(asc(llmCalls.createdAt)),
    reachOf([{ repoId: repo.id, groupKey: run.groupKey }]),
    dry
      ? db
          .select({ payload: runEvents.payload })
          .from(runEvents)
          .where(and(eq(runEvents.runId, run.id), eq(runEvents.step, "pr"), eq(runEvents.type, "dry-run")))
          .limit(1)
      : Promise.resolve([]),
    dry
      ? db
          .select({ id: publicScans.id })
          .from(publicScans)
          .where(and(eq(publicScans.repoId, repo.id), eq(publicScans.status, "done")))
          .orderBy(desc(publicScans.createdAt))
          .limit(1)
      : Promise.resolve([]),
    getSession(),
  ]);
  const member =
    !dry && session && repo.installationId
      ? (
          await db
            .select({ id: userInstallations.installationId })
            .from(userInstallations)
            .where(
              and(
                eq(userInstallations.userId, session.user.id),
                eq(userInstallations.installationId, repo.installationId),
              ),
            )
            .limit(1)
        ).length > 0
      : false;
  return {
    run: {
      id: run.id,
      kind: run.kind,
      status: run.status,
      step: run.step,
      groupKey: run.groupKey,
      fromVersion: run.fromVersion,
      targetVersion: run.targetVersion,
      evidenceKind: run.evidenceKind,
      prMode: run.prMode,
      backend: run.backend,
      error: run.error ? maskSecrets(run.error) : null,
      costUsd: run.costUsd,
      diff: run.diff ? maskSecrets(run.diff) : null,
      diffHash: createHash("md5")
        .update(run.diff ?? "", "utf8")
        .digest("hex"),
      cancelledBy: run.cancelledBy,
      startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt),
      createdAt: run.createdAt.toISOString(),
    },
    repo: { fullName: repo.fullName, isPrivate: repo.isPrivate },
    artifact: artifact
      ? {
          kind: artifact.kind,
          number: artifact.number,
          url: artifact.url,
          state: artifact.state,
          runId: artifact.runId,
        }
      : null,
    verification: masked((run.verification as RunSheetData["verification"]) ?? null),
    events: events.map((e) => ({
      seq: e.seq,
      at: e.at.toISOString(),
      step: e.step,
      type: e.type,
      payload: masked(e.payload),
    })),
    execs: execs.map((x) => ({
      id: String(x.id),
      phase: x.phase,
      command: maskSecrets(x.command),
      exitCode: x.exitCode,
      timedOut: x.timedOut,
      durationMs: x.durationMs,
      backend: x.backend,
      stdoutTail: x.stdoutTail ? maskSecrets(x.stdoutTail) : null,
      createdAt: x.createdAt.toISOString(),
    })),
    calls: calls.map((c) => ({
      id: String(c.id),
      purpose: c.purpose,
      step: c.step,
      model: c.model,
      tokensIn: c.tokensIn,
      tokensOut: c.tokensOut,
      latencyMs: c.latencyMs,
      costUsd: c.costUsd,
      createdAt: c.createdAt.toISOString(),
    })),
    reach: reach.get(reachKey(repo.id, run.groupKey)) ?? { sites: null, advisory: false },
    preview: masked((preview?.payload as RunSheetData["preview"]) ?? null),
    report: report?.id ?? null,
    member,
  };
}

/**
 * A dry run asked for but not yet a run (the page opens before the worker creates it): its request in
 * the outbox, with the reason if the worker couldn't take it. Null when no such request exists.
 */
export async function dryRunRequest(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
  const [row] = await database()
    .select({ error: webhookDeliveries.error, processedAt: webhookDeliveries.processedAt })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.guid, `teire-dry-run-${id}`))
    .limit(1);
  return row ? { error: row.error ? maskSecrets(row.error) : null, processed: !!row.processedAt } : null;
}

/** A poll tick (U2): what moves while a run works. Everything else stays from the first load. */
export type RunSheetTick = Pick<RunSheetData, "artifact" | "verification" | "events" | "execs" | "calls"> & {
  run: Omit<RunSheetData["run"], "diff"> & { diff?: string | null };
};

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * One poll tick in one query (plan "performance and data": each tick is one pooled query): the run,
 * its PR or issue, the events after `after`, its receipts, and the repository's visibility. A private
 * repository's run also reads the person's membership. The diff is sent only when its length changed.
 */
export async function runSheetTick(
  id: string,
  after: number,
  diffHash: string,
): Promise<RunSheetTick | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const db = database();
  const { rows } = await db.execute<{ sheet: Row }>(sql`
    select json_build_object(
      'run', to_jsonb(r) - 'diff' || jsonb_build_object(
        'diff', case when md5(coalesce(r.diff, '')) = ${diffHash} then null else r.diff end,
        'diff_hash', md5(coalesce(r.diff, '')),
        'diff_changed', md5(coalesce(r.diff, '')) <> ${diffHash}),
      'is_private', p.is_private,
      'repo_id', p.id,
      'installation_id', p.installation_id,
      'artifact', (
        select to_jsonb(a) from artifacts a
        where a.repo_id = r.repo_id and (a.run_id = r.id or (
          r.kind <> 'dry_run' and (r.kind = 'reverify' or r.status = 'succeeded')
          and a.kind = 'pr' and a.change_key = r.group_key))
        order by (a.run_id = r.id) desc, (a.kind = 'pr') desc limit 1),
      'events', coalesce((select jsonb_agg(jsonb_build_object('seq', e.seq, 'at', e.at, 'step', e.step,
        'type', e.type, 'payload', e.payload) order by e.seq) from run_events e
        where e.run_id = r.id and e.seq > ${after}), '[]'::jsonb),
      'execs', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from sandbox_execs x
        where x.run_id = r.id), '[]'::jsonb),
      'calls', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at) from llm_calls c
        where c.run_id = r.id), '[]'::jsonb)
    ) as sheet
    from runs r join repos p on p.id = r.repo_id where r.id = ${id}
  `);
  const sheet = rows[0]?.sheet;
  if (!sheet) return null;
  // A private repository's run is for the members of its installation, read now.
  if (sheet.is_private) {
    const session = await auth().api.getSession({ headers: await headers() });
    if (!session || !sheet.installation_id) return null;
    // The person's own access to this private repository (U3 review), as on the first read.
    const [member] = await db
      .select({ id: userRepos.repoId })
      .from(userRepos)
      .where(
        and(
          eq(userRepos.userId, session.user.id),
          eq(userRepos.repoId, Number(sheet.repo_id)),
          eq(userRepos.installationId, Number(sheet.installation_id)),
        ),
      )
      .limit(1);
    if (!member) return null;
  }
  const r = sheet.run as Row;
  const a = sheet.artifact as Row | null;
  const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
  return {
    run: {
      id: String(r.id),
      kind: String(r.kind),
      status: String(r.status),
      step: str(r.step),
      groupKey: str(r.group_key),
      fromVersion: str(r.from_version),
      targetVersion: str(r.target_version),
      evidenceKind: str(r.evidence_kind),
      prMode: str(r.pr_mode),
      backend: str(r.backend),
      error: r.error ? maskSecrets(String(r.error)) : null,
      costUsd: String(r.cost_usd ?? "0"),
      ...(r.diff_changed ? { diff: r.diff ? maskSecrets(String(r.diff)) : null } : {}),
      diffHash: String(r.diff_hash),
      cancelledBy: str(r.cancelled_by),
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
      createdAt: iso(r.created_at) ?? "",
    },
    artifact: a
      ? {
          kind: String(a.kind),
          number: num(a.number),
          url: str(a.url),
          state: String(a.state),
          runId: str(a.run_id),
        }
      : null,
    verification: masked((r.verification as RunSheetData["verification"]) ?? null),
    events: ((sheet.events as Row[]) ?? []).map((e) => ({
      seq: Number(e.seq),
      at: iso(e.at) ?? "",
      step: String(e.step),
      type: String(e.type),
      payload: masked(e.payload),
    })),
    execs: ((sheet.execs as Row[]) ?? []).map((x) => ({
      id: String(x.id),
      phase: String(x.phase),
      command: maskSecrets(String(x.command)),
      exitCode: num(x.exit_code),
      timedOut: Boolean(x.timed_out),
      durationMs: num(x.duration_ms),
      backend: String(x.backend),
      stdoutTail: x.stdout_tail ? maskSecrets(String(x.stdout_tail)) : null,
      createdAt: iso(x.created_at) ?? "",
    })),
    calls: ((sheet.calls as Row[]) ?? []).map((c) => ({
      id: String(c.id),
      purpose: String(c.purpose),
      step: str(c.step),
      model: String(c.model),
      tokensIn: Number(c.tokens_in ?? 0),
      tokensOut: Number(c.tokens_out ?? 0),
      latencyMs: num(c.latency_ms),
      costUsd: String(c.cost_usd ?? "0"),
      createdAt: iso(c.created_at) ?? "",
    })),
  };
}
