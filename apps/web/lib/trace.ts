import type { TraceSpan } from "@/components/ui/agent-trace";
import { toolSaid } from "./activity";

/**
 * A run as a waterfall (the run page's trace): every span is a real record, placed on the run's own
 * clock. Sandbox commands end when they were recorded and last their measured duration; the updater
 * runs from its start to its done event; each agent attempt holds its tool calls (their measured
 * milliseconds); review calls and the PR close it.
 */
interface EventIn {
  seq: number;
  at: Date;
  step: string;
  type: string;
  payload: unknown;
}
interface ExecIn {
  id: string | number;
  phase: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number | null;
  createdAt: Date;
}
interface CallIn {
  id: string | number;
  purpose: string;
  step: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number | null;
  createdAt: Date;
}

const PHASE: Record<string, string> = {
  resolve: "updater",
  install_baseline: "baseline · install",
  baseline: "baseline",
  install_after: "after · install",
  after: "after",
};

export function traceOf(events: EventIn[], execs: ExecIn[], calls: CallIn[], startedAt: Date | null) {
  const times = [
    ...events.map((e) => e.at.getTime()),
    ...execs.map((x) => x.createdAt.getTime() - (x.durationMs ?? 0)),
  ];
  const t0 = startedAt?.getTime() ?? (times.length ? Math.min(...times) : Date.now());
  const rel = (t: number) => Math.max(0, t - t0);
  const spans: TraceSpan[] = [];

  // The updater: from its start to its last word.
  const resolver = events.filter((e) => e.step === "resolver");
  if (resolver.length) {
    const first = resolver[0] as EventIn;
    const last = resolver.at(-1) as EventIn;
    const stop = resolver.some((e) => e.type === "stop" || e.type === "stopped");
    spans.push({
      id: "updater",
      label: "dependabot-core updater",
      kind: "agent",
      start: rel(first.at.getTime()),
      end: Math.max(rel(last.at.getTime()), rel(first.at.getTime()) + 400),
      ...(stop ? { status: "error" as const } : {}),
      detail: stop ? "stopped" : "files changed",
    });
  }

  // Sandbox commands, placed by the log line written when each finished ("baseline: test exit 0 in
  // 2214 ms"); the sandbox records themselves are written together at the end of the run.
  const finished = /^(baseline|after): (.+?) exit (-?\d+) in (\d+) ms/;
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const m = typeof p.detail === "string" ? finished.exec(p.detail) : null;
    if (!m) continue;
    const [, side, what, code, ms] = m;
    const end = rel(e.at.getTime());
    spans.push({
      id: `exec-${e.seq}`,
      label: `${side} · ${what}`.replace(/ \(.*\)$/, "").slice(0, 48),
      kind: "tool",
      start: Math.max(0, end - Number(ms)),
      end: Math.max(end, end - Number(ms) + 200),
      ...(code !== "0" ? { status: "error" as const } : {}),
      detail: `exit ${code}`,
    });
  }
  if (!spans.some((s) => s.id.startsWith("exec-")))
    for (const x of execs) {
      const end = rel(x.createdAt.getTime());
      const ms = x.durationMs ?? 0;
      spans.push({
        id: `exec-${x.id}`,
        label: `${PHASE[x.phase] ?? x.phase} · ${x.command}`.slice(0, 48),
        kind: "tool",
        start: Math.max(0, end - ms),
        end: Math.max(end, end - ms + 200),
        ...(x.timedOut || (x.exitCode ?? 0) !== 0 ? { status: "error" as const } : {}),
        detail: x.timedOut ? "timed out" : `exit ${x.exitCode}`,
      });
    }

  // Agent attempts: the tool calls between two verdicts are one attempt, shown as one span with its
  // count (each call is in the run's steps); a trace of a hundred rows would read as noise.
  let attempt = 0;
  let current: (TraceSpan & { calls: number; edits: number }) | null = null;
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.step === "verify" || e.step === "replan") {
      current = null;
      continue;
    }
    if (e.step !== "agent" || typeof p.detail !== "string") continue;
    const end = rel(e.at.getTime());
    const ms = typeof p.ms === "number" ? p.ms : 500;
    if (!current) {
      attempt++;
      current = {
        id: `attempt-${attempt}`,
        label: "Nemotron 3 Ultra",
        kind: "agent",
        start: Math.max(0, end - ms),
        end,
        calls: 0,
        edits: 0,
        ...(attempt > 1 ? { attempt } : {}),
      };
      spans.push(current);
    }
    current.end = Math.max(current.end, end);
    current.calls++;
    if (toolSaid(p.detail).tool === "edit_file") current.edits++;
    current.detail = `${current.calls} steps · ${current.edits} edits`;
  }

  for (const c of calls.filter((x) => x.purpose === "review")) {
    const end = rel(c.createdAt.getTime());
    const ms = c.latencyMs ?? 800;
    spans.push({
      id: `call-${c.id}`,
      label: "review",
      kind: "model",
      start: Math.max(0, end - ms),
      end: Math.max(end, end - ms + 200),
      tokens: c.tokensIn + c.tokensOut,
      detail: c.model.replace(/^nvidia\//, ""),
    });
  }

  const pr = events.find((e) => e.step === "pr");
  if (pr) {
    const at = rel(pr.at.getTime());
    spans.push({
      id: "pr",
      label: pr.type === "issue" ? "issue" : "pull request",
      kind: "io",
      start: at,
      end: at + 600,
      detail: pr.type,
    });
  }

  return spans.sort((a, b) => a.start - b.start);
}
