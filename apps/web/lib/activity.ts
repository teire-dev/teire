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
  /** An edit's old and new text (the mini diff). */
  edit?: { removed: string; added: string };
  /** What a `run_check` reported, one line per check (its ledger delta). */
  result?: string[];
}

export interface PlanItem {
  text: string;
  status: "pending" | "in_progress" | "done";
}

export interface ActivityRow {
  key: string;
  step: string;
  title: string;
  state: "done" | "live" | "failed" | "waiting";
  lines: string[];
  tools: ToolLine[];
  execs: Exec[];
  /** The agent's plan as it last set it. */
  plan?: PlanItem[];
  startedAt: Date;
  endedAt: Date;
  costUsd: number;
}

const TITLES: Record<string, [live: string, done: string]> = {
  queue: ["Waiting for its turn", "Queued"],
  assess: ["Assessing the change", "Assessed the change"],
  resolver: ["dependabot-core's updater is changing the dependency files", "dependabot-core's updater"],
  transaction: ["Applying the dependency change", "Applied the dependency change"],
  codemod: ["Making the deterministic edits", "Deterministic edits"],
  install: ["Installing in the sandbox", "Installed in the sandbox"],
  baseline: ["Running your checks on the unchanged repository", "Baseline: your checks before the change"],
  agent: ["The agent is fixing the code", "The agent fixed the code"],
  replan: ["Planning again", "Planned again"],
  check: ["Running your checks after the change", "Your checks after the change"],
  review: ["Reviewing the diff", "Reviewed the diff"],
  verify: ["Deciding the evidence", "Evidence"],
  pr: ["Opening the pull request", "Pull request"],
  progress: ["Updating the progress comment", "Progress comment"],
  ci: ["Reading the repository's CI", "The repository's CI"],
  run: ["Finishing", "Run"],
  restart: ["Starting over", "Started over"],
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

/** A structured tool call (`{name, input}`) in the same words as `toolSaid`. */
export function callSaid(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string).replace(/^\.\//, "") : null);
  const n = (k: string) => (typeof input[k] === "number" ? (input[k] as number) : null);
  switch (name) {
    case "read_file":
      return `Reading ${s("path") ?? "a file"}${n("startLine") ? ` (lines ${n("startLine")}–${n("endLine") ?? "…"})` : ""}`;
    case "edit_file":
      return `Editing ${s("path") ?? "a file"}`;
    case "search":
      return `Searching ${s("pattern") ?? s("query") ?? ""}`.trim();
    case "run_check":
      return "Running your checks";
    case "lookup_docs":
      return `Looking up ${s("query") ?? "the docs"}`;
    case "finish":
      return "Finished";
    default:
      return name;
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
/**
 * A model's name as people say it, from the id the calls recorded (`nvidia/Nemotron-3-Ultra-550b-a55b`
 * → "Nemotron 3 Ultra"); any other id is shown without its vendor prefix.
 */
export function modelLabel(model: string | null | undefined) {
  if (!model) return null;
  const id = model.replace(/^[\w.-]+\//, "");
  const nemotron = /^Nemotron-(\d+)-(Ultra|Super|Nano)\b/i.exec(id);
  return nemotron ? `Nemotron ${nemotron[1]} ${nemotron[2]}` : id;
}

export function activityOf(
  events: Event[],
  execs: Exec[],
  active: boolean,
  model?: string | null,
): ActivityRow[] {
  // The agent is named by the model its calls recorded (review round 2), never typed in.
  const name = modelLabel(model);
  const TITLE: typeof TITLES = name
    ? { ...TITLES, agent: [`${name} is fixing the code`, `${name} fixed the code`] }
    : TITLES;
  const rows: ActivityRow[] = [];
  // A run_check's results are logged while the tool runs, before the agent's step that names it:
  // they wait on the agent's row and join that tool line (its ledger delta); left over, they are a
  // check row of their own.
  let held: { row: ActivityRow; lines: string[]; at: Date; seq: number } | null = null;
  const flush = () => {
    if (!held?.lines.length) {
      held = null;
      return;
    }
    rows.push({
      key: `check-${held.seq}`,
      step: "check",
      title: TITLE.check?.[1] ?? "check",
      state: held.lines.some((l) => / exit (?!0 )/.test(l)) ? "failed" : "done",
      lines: held.lines,
      tools: [],
      execs: [],
      startedAt: held.at,
      endedAt: held.at,
      costUsd: 0,
    });
    held = null;
  };
  for (const e of events) {
    // What the run read is the Context tab's, not a step.
    if (e.step === "context") continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const last = rows.at(-1);
    if (e.step === "check" && last?.step === "agent" && typeof p.detail === "string") {
      held ??= { row: last, lines: [], at: e.at, seq: e.seq };
      held.lines.push(p.detail);
      continue;
    }
    if (held && e.step !== "agent") flush();
    const tail = rows.at(-1);
    const row: ActivityRow =
      tail && tail.step === e.step
        ? tail
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
    if (row !== tail) rows.push(row);
    row.endedAt = e.at;
    if (typeof p.costUsd === "number") row.costUsd += p.costUsd;
    if (e.step === "agent" && typeof p.detail === "string") {
      const calls = Array.isArray(p.calls)
        ? (p.calls as { name: string; input: Record<string, unknown> }[])
        : null;
      const edits = Array.isArray(p.edits) ? (p.edits as { removed: string; added: string }[]) : [];
      if (Array.isArray(p.plan)) row.plan = p.plan as PlanItem[];
      const lines = calls
        ? calls
            .filter((c) => c.name !== "update_plan")
            .map((c) => ({ tool: c.name, said: callSaid(c.name, c.input ?? {}) }))
        : [toolSaid(p.detail)];
      let edit = 0;
      lines.forEach((l, i) => {
        row.tools.push({
          seq: e.seq * 100 + i,
          ...l,
          // The step's time and cost belong to its first call.
          ms: i === 0 && typeof p.ms === "number" ? p.ms : null,
          costUsd: i === 0 && typeof p.costUsd === "number" ? p.costUsd : null,
          ...(l.tool === "edit_file" && edits[edit] ? { edit: edits[edit++] } : {}),
          ...(l.tool === "run_check" && held?.lines.length ? { result: held.lines } : {}),
        });
        if (l.tool === "run_check" && held) held = null;
      });
      if (!lines.length && !calls)
        row.tools.push({ seq: e.seq, ...toolSaid(p.detail), ms: null, costUsd: null });
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
  flush();
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
