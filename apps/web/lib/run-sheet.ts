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
} from "@teire/db";
import { visibleRun } from "./access";
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
    cancelledBy: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
  };
  repo: { fullName: string; isPrivate: boolean };
  artifact: { kind: string; number: number | null; url: string | null; state: string } | null;
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
      .orderBy(sql`${artifacts.runId} = ${run.id} desc`)
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
      error: run.error,
      costUsd: run.costUsd,
      diff: run.diff,
      cancelledBy: run.cancelledBy,
      startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt),
      createdAt: run.createdAt.toISOString(),
    },
    repo: { fullName: repo.fullName, isPrivate: repo.isPrivate },
    artifact: artifact
      ? { kind: artifact.kind, number: artifact.number, url: artifact.url, state: artifact.state }
      : null,
    verification: (run.verification as RunSheetData["verification"]) ?? null,
    events: events.map((e) => ({
      seq: e.seq,
      at: e.at.toISOString(),
      step: e.step,
      type: e.type,
      payload: e.payload,
    })),
    execs: execs.map((x) => ({
      id: String(x.id),
      phase: x.phase,
      command: x.command,
      exitCode: x.exitCode,
      timedOut: x.timedOut,
      durationMs: x.durationMs,
      backend: x.backend,
      stdoutTail: x.stdoutTail,
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
    preview: (preview?.payload as RunSheetData["preview"]) ?? null,
    report: report?.id ?? null,
    member,
  };
}
