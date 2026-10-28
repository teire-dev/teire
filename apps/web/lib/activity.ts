/**
 * A run's activity as step rows (plan revision 3.3, "Run, the proof sheet"; Factory's session
 * grammar): the events the worker wrote, grouped by step in the order they happened, with each
 * sandbox command under the step it belongs to and each agent tool call as its own line, in words
 * ("Reading lib/x.rb (lines 100–115)").
 */
export interface Exec {
  id: string | number;
  phase: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number | null;
  stdoutTail: string | null;
  stderrTail: string | null;
}

export interface Event {
  seq: number;
  at: Date;
  step: string;
  type: string;
  payload: unknown;
}

export interface ToolLine {
  seq: number;
  tool: string;
  said: string;
  ms: number | null;
  costUsd: number | null;
}

export interface ActivityRow {
  key: string;
  step: string;
  title: string;
  state: "done" | "live" | "failed" | "waiting";
  lines: string[];
  tools: ToolLine[];
  execs: Exec[];
  startedAt: Date;
  endedAt: Date;
  costUsd: number;
}

const TITLE: Record<string, [live: string, done: string]> = {
  queue: ["Waiting for its turn", "Queued"],
  assess: ["Assessing the change", "Assessed the change"],
  resolver: ["dependabot-core's updater is changing the dependency files", "dependabot-core's updater"],
  transaction: ["Applying the dependency change", "Applied the dependency change"],
  codemod: ["Making the deterministic edits", "Deterministic edits"],
  install: ["Installing in the sandbox", "Installed in the sandbox"],
  baseline: ["Running your checks on the unchanged repository", "Baseline: your checks before the change"],
  agent: ["Nemotron 3 Ultra is fixing the code", "Nemotron 3 Ultra fixed the code"],
  replan: ["Planning again", "Planned again"],
  check: ["Running your checks after the change", "Your checks after the change"],
  review: ["Reviewing the diff", "Reviewed the diff"],
  verify: ["Deciding the evidence", "Evidence"],
  pr: ["Opening the pull request", "Pull request"],
  progress: ["Updating the progress comment", "Progress comment"],
  ci: ["Reading the repository's CI", "The repository's CI"],
  run: ["Finishing", "Run"],
};

/** Sandbox phases belong to the step that ran them. */
const PHASE_STEP: Record<string, string> = {
  resolve: "resolver",
  install_baseline: "baseline",
  baseline: "baseline",
  install_after: "check",
  after: "check",
};

const pick = (text: string, key: string) =>
  new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text)?.[1]?.replace(/^\.\//, "");
const pickNumber = (text: string, key: string) => new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(text)?.[1];

/** An agent tool call (`edit_file({"path":…})`, possibly truncated) in present-tense words. */
export function toolSaid(detail: string): { tool: string; said: string } {
  const tool = /^([a-z_]+)\(/.exec(detail)?.[1] ?? "step";
  const path = pick(detail, "path");
  switch (tool) {
    case "read_file": {
      const from = pickNumber(detail, "startLine");
      const to = pickNumber(detail, "endLine");
      return { tool, said: `Reading ${path ?? "a file"}${from ? ` (lines ${from}–${to ?? "…"})` : ""}` };
    }
    case "edit_file":
      return { tool, said: `Editing ${path ?? "a file"}` };
    case "search":
      return { tool, said: `Searching ${pick(detail, "pattern") ?? pick(detail, "query") ?? ""}`.trim() };
    case "run_check":
      return { tool, said: `Running the ${pick(detail, "name") ?? "check"} check` };
    case "lookup_docs":
      return { tool, said: `Looking up ${pick(detail, "query") ?? pick(detail, "library") ?? "the docs"}` };
    case "finish":
      return { tool, said: "Finished" };
    default:
      return { tool, said: detail.slice(0, 160) };
  }
}

function lineOf(e: Event): string | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (typeof p.detail === "string") return p.detail;
  if (typeof p.reason === "string") return p.reason;
  if (e.step === "resolver" && e.type === "started")
    return `${p.dependency} with ${p.packageManager} across ${(p.roots as string[] | undefined)?.length ?? 1} root${(p.roots as string[] | undefined)?.length === 1 ? "" : "s"}`;
  if (e.step === "resolver" && e.type === "change") {
    const moved = (p.moved as { name: string; from?: string; to?: string }[] | undefined) ?? [];
    return `changed ${(p.files as string[] | undefined)?.join(", ")}${moved.length ? `; ${moved.map((m) => `${m.name} ${m.from ?? "?"} → ${m.to ?? "?"}`).join(", ")}` : ""}`;
  }
  if (e.step === "assess" && e.type === "started") return `${p.from ?? "?"} → ${p.target ?? "?"}`;
  if (e.step === "pr")
    return typeof p.url === "string" ? `${e.type} ${p.url}${p.draft ? " (draft)" : ""}` : e.type;
  if (e.type === "running" || e.type === "done" || e.type === "queued") return null;
  return e.type;
}

/** The rows, in order; the last one is live while the run is. */
export function activityOf(events: Event[], execs: Exec[], active: boolean): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const e of events) {
    const last = rows.at(-1);
    const row: ActivityRow =
      last && last.step === e.step
        ? last
        : {
            key: `${e.step}-${e.seq}`,
            step: e.step,
            title: TITLE[e.step]?.[1] ?? e.step,
            state: "done",
            lines: [],
            tools: [],
            execs: [],
            startedAt: e.at,
            endedAt: e.at,
            costUsd: 0,
          };
    if (row !== last) rows.push(row);
    row.endedAt = e.at;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (typeof p.costUsd === "number") row.costUsd += p.costUsd;
    if (e.step === "agent" && typeof p.detail === "string") {
      row.tools.push({
        seq: e.seq,
        ...toolSaid(p.detail),
        ms: typeof p.ms === "number" ? p.ms : null,
        costUsd: typeof p.costUsd === "number" ? p.costUsd : null,
      });
      continue;
    }
    if (
      ["stop", "stopped", "failed", "failure"].includes(e.type) ||
      /^regression|^stopped/.test(String(p.detail ?? ""))
    )
      row.state = "failed";
    if (e.type === "deferred") row.state = "waiting";
    const line = lineOf(e);
    if (line && !row.lines.includes(line)) row.lines.push(line);
  }
  // Each sandbox command joins the last row of the step its phase belongs to.
  for (const x of execs) {
    const step = PHASE_STEP[x.phase] ?? x.phase;
    const row = [...rows].reverse().find((r) => r.step === step) ?? rows.find((r) => r.step === "check");
    row?.execs.push(x);
  }
  const tail = rows.at(-1);
  if (active && tail && tail.state !== "failed") {
    tail.state = "live";
    tail.title = TITLE[tail.step]?.[0] ?? tail.title;
  }
  return rows;
}
