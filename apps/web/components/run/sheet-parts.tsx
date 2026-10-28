"use client";

import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FileCode2,
  FilePen,
  Flag,
  FlaskConical,
  ListChecks,
  Search,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { LedgerCheck } from "@/components/teire/ledger";
import type { Phase } from "@/components/teire/phase-strip";
import { EvidenceChip, StatusChip, type Tone } from "@/components/teire/status-chip";
import type { ActivityRow, Exec, PlanItem } from "@/lib/activity";
import { STEP_DOING } from "@/lib/proof";
import type { RunSheetData } from "@/lib/run-sheet";
import { backendName, cn } from "@/lib/utils";

/** "45s", "3m 12s": whole seconds first, so 119.6 s reads "2m 0s". */
export const duration = (ms: number | null) => {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** The run's subject: a package and its versions, or the models a swap replaces. */
export function subjectOf(run: RunSheetData["run"]) {
  const [head, ...rest] = (run.groupKey ?? "").split("/");
  const api = head === "models" || head === "api";
  return {
    kind: api ? (head === "models" ? "Model retirement" : "API change") : "Package upgrade",
    name: api ? (rest[0] ?? "") : rest.slice(0, -1).join("/"),
    from: (run.fromVersion ?? "").split(", ").filter(Boolean),
    to: (run.targetVersion ?? "").split(", ").filter(Boolean),
  };
}

/**
 * The ledger while a run works: each check's log line ("after: test exit 0 in 2214 ms (70/70
 * passed)"), the last round per check. The stored checks replace it when the run ends.
 */
export function liveLedger(events: RunSheetData["events"]) {
  const sides: Record<"baseline" | "after", Map<string, LedgerCheck>> = {
    baseline: new Map(),
    after: new Map(),
  };
  for (const e of events) {
    const detail = (e.payload as { detail?: unknown } | null)?.detail;
    const m =
      typeof detail === "string"
        ? /^(baseline|after): (typecheck|build|test) exit (-?\d+) in (\d+) ms(?: \((\d+)\/(\d+) passed\))?/.exec(
            detail,
          )
        : null;
    if (!m) continue;
    const [, side, name = "", code, ms, passed, collected] = m;
    const exitCode = Number(code);
    sides[side as "baseline" | "after"].set(name, {
      name,
      argv: [],
      exitCode,
      timedOut: exitCode === 124,
      ms: Number(ms),
      counts:
        passed && collected
          ? {
              collected: Number(collected),
              passed: Number(passed),
              failed: exitCode === 0 ? 0 : Number(collected) - Number(passed),
              skipped: 0,
              errors: 0,
            }
          : null,
    });
  }
  return { baseline: [...sides.baseline.values()], after: [...sides.after.values()] };
}

/** When the run's work first began: its first "started" event, else its recorded start. */
export function firstStart(sheet: RunSheetData) {
  return sheet.events.find((e) => e.step === "assess" && e.type === "started")?.at ?? sheet.run.startedAt;
}

/** Where the run's time went, from its own records (no figure it didn't measure). */
export function phasesOf(sheet: RunSheetData): Phase[] {
  const { run, events, execs } = sheet;
  // A run's sandbox records are written together when it ends; while it works, the line each command
  // logs when it finishes ("baseline: test exit 0 in 2214 ms") stands in for them.
  const logged = (side: "baseline" | "after") =>
    events.flatMap((e) => {
      const detail = (e.payload as { detail?: unknown } | null)?.detail;
      const m =
        typeof detail === "string" ? /^(baseline|after): .+? exit (-?\d+) in (\d+) ms/.exec(detail) : null;
      return m && m[1] === side ? [{ ms: Number(m[3]), failed: m[2] !== "0" }] : [];
    });
  const recorded = (phases: string[]) => execs.some((x) => phases.includes(x.phase));
  const sum = (phases: string[], side: "baseline" | "after") =>
    recorded(phases)
      ? execs.filter((x) => phases.includes(x.phase)).reduce((n, x) => n + (x.durationMs ?? 0), 0)
      : logged(side).reduce((n, l) => n + l.ms, 0);
  const failed = (phases: string[], side: "baseline" | "after") =>
    recorded(phases)
      ? execs.some((x) => phases.includes(x.phase) && (x.timedOut || (x.exitCode ?? 0) !== 0))
      : logged(side).some((l) => l.failed);
  const span = (steps: string[]) => {
    const at = events.filter((e) => steps.includes(e.step)).map((e) => Date.parse(e.at));
    return at.length ? Math.max(...at) - Math.min(...at) : null;
  };
  const active = run.status === "running" || run.status === "stopping";
  const began = firstStart(sheet);
  const queued = began ? Date.parse(began) - Date.parse(run.createdAt) : null;
  const updater = span(["resolver"]);
  const fix = span(["codemod", "agent", "replan"]);
  const pr = events.find((e) => e.step === "pr");
  const state = (ms: number | null, bad = false): Phase["state"] =>
    bad ? "failed" : ms === null ? (active ? "pending" : "skipped") : "done";
  return [
    { key: "queued", label: "Queued", ms: queued, state: queued === null ? "pending" : "done" },
    { key: "updater", label: "Updater", ms: updater, state: state(updater) },
    {
      key: "baseline",
      label: "Baseline",
      ms: sum(["install_baseline", "baseline"], "baseline") || null,
      state: state(
        sum(["install_baseline", "baseline"], "baseline") || null,
        failed(["install_baseline", "baseline"], "baseline"),
      ),
    },
    { key: "fix", label: "Fix", ms: fix, state: state(fix) },
    {
      key: "checks",
      label: "Your checks",
      ms: sum(["install_after", "after"], "after") || null,
      state: state(
        sum(["install_after", "after"], "after") || null,
        failed(["install_after", "after"], "after"),
      ),
    },
    {
      key: "pr",
      label: sheet.artifact?.kind === "issue" ? "Issue" : "PR",
      ms: null,
      state: pr ? "done" : active ? "pending" : "skipped",
    },
  ];
}

const STATE_MARK: Record<ActivityRow["state"], { glyph: string; tone: string }> = {
  done: { glyph: "✓", tone: "text-ink-2" },
  live: { glyph: "●", tone: "text-signal" },
  failed: { glyph: "✕", tone: "text-broke" },
  waiting: { glyph: "◷", tone: "text-attention" },
};

const TOOL_ICON: Record<string, typeof FileCode2> = {
  read_file: FileCode2,
  edit_file: FilePen,
  search: Search,
  run_check: FlaskConical,
  finish: Flag,
};

/** One step of the run (Factory's step rows): live and open while Teire is on it, tools and commands inside. */
export function ActivityItem({ row, open }: { row: ActivityRow; open: boolean }) {
  const mark = STATE_MARK[row.state];
  const ms = row.endedAt.getTime() - row.startedAt.getTime();
  const count = row.tools.length + row.execs.length + row.lines.length;
  return (
    <li>
      <details open={open} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-hover [&::-webkit-details-marker]:hidden">
          <span
            className={cn(
              "w-3 text-center font-mono text-xs",
              mark.tone,
              row.state === "live" && "animate-pulse",
            )}
            aria-hidden
          >
            {mark.glyph}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-ink">{row.title}</span>
          {row.tools.length ? (
            <span className="hidden font-mono text-[11px] text-ink-3 sm:inline">
              {row.tools.length} step{row.tools.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {row.costUsd ? (
            <span className="hidden font-mono text-[11px] text-ink-3 sm:inline">
              ${row.costUsd.toFixed(3)}
            </span>
          ) : null}
          <span className="w-14 text-right font-mono text-[11px] text-ink-3">
            {ms > 999 ? duration(ms) : ""}
          </span>
          <ChevronRight
            className="size-3.5 text-ink-3 transition-transform group-open:rotate-90"
            aria-hidden
          />
        </summary>
        {count ? (
          <div className="flex flex-col gap-1.5 pr-4 pb-4 pl-10">
            {row.lines.map((l) => (
              <p key={l} className="text-xs leading-relaxed text-ink-2">
                {l}
              </p>
            ))}
            {row.plan?.length ? <PlanBlock plan={row.plan} /> : null}
            {row.tools.length ? (
              <ul className="mt-1 flex flex-col gap-1">
                {row.tools.map((t) => {
                  const Icon = TOOL_ICON[t.tool] ?? SquareTerminal;
                  return (
                    <li key={t.seq} className="flex flex-col gap-1">
                      <span className="flex items-center gap-2 text-xs">
                        <Icon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                        <span className="min-w-0 flex-1 truncate font-mono text-ink-2">{t.said}</span>
                        {t.ms ? (
                          <span className="font-mono text-[11px] text-ink-3">
                            {(t.ms / 1000).toFixed(1)} s
                          </span>
                        ) : null}
                      </span>
                      {t.edit ? <MiniDiff removed={t.edit.removed} added={t.edit.added} /> : null}
                      {t.result?.length ? (
                        <span className="ml-5 flex flex-wrap gap-x-3 font-mono text-[11px]">
                          {t.result.map((r) => {
                            const ok = / exit 0 /.test(r);
                            return (
                              <span key={r} className={ok ? "text-ink-2" : "text-broke"}>
                                {ok ? "✓" : "✕"} {r.replace(/^after: /, "").replace(/ in \d+ ms/, "")}
                              </span>
                            );
                          })}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {row.execs.map((x) => (
              <Terminal key={x.id} exec={x} />
            ))}
          </div>
        ) : null}
      </details>
    </li>
  );
}

/** One sandbox command: the phase dim, the command in ink mono with copy, its exit and time; output on open. */
export function Terminal({ exec }: { exec: Exec }) {
  const ok = exec.exitCode === 0 && !exec.timedOut;
  // Tokens in a command line never show (`https://*****@github.com/…`).
  const command = exec.command.replace(/(https?:\/\/)[^\s/@]+@/g, "$1*****@");
  const out = `${exec.stdoutTail ?? ""}${exec.stderrTail ? `\n${exec.stderrTail}` : ""}`.trim();
  const [copied, setCopied] = useState(false);
  return (
    <details className="group/t mt-1 rounded-md bg-sunken ring-1 ring-rule ring-inset">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-mono text-[11px] [&::-webkit-details-marker]:hidden">
        <span className="text-ink-3">{exec.phase.replace(/_/g, " ")}</span>
        <span className="min-w-0 flex-1 truncate text-ink">$ {command}</span>
        <button
          type="button"
          className="rounded p-0.5 text-ink-3 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-signal"
          aria-label={copied ? "Copied" : "Copy the command"}
          onClick={(e) => {
            e.preventDefault();
            void navigator.clipboard.writeText(command).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
        </button>
        <span className={ok ? "text-ink-2" : "text-broke"}>
          {exec.timedOut ? "timed out" : `exit ${exec.exitCode}`}
        </span>
        <span className="text-ink-3">{duration(exec.durationMs)}</span>
      </summary>
      <pre className="max-h-56 overflow-auto border-t border-rule px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-2">
        {out ? out.slice(-4000) : "No output was kept."}
      </pre>
    </details>
  );
}

export interface ContextItem {
  title: string;
  url: string | null;
  quote: string | null;
}

/**
 * What the run read to decide (the right column's Context): the release notes, provider pages and
 * docs answers it recorded as sources, grouped by kind; an older run's docs lookups from its steps.
 */
export function contextOf(sheet: RunSheetData): [string, ContextItem[]][] {
  const groups: Record<string, ContextItem[]> = {
    "Release notes": [],
    "Provider pages": [],
    "Docs answers": [],
  };
  const kinds: Record<string, string> = {
    "release-notes": "Release notes",
    provider: "Provider pages",
    docs: "Docs answers",
  };
  let recorded = false;
  for (const e of sheet.events) {
    const source = (
      e.payload as { source?: { kind?: string; title?: string; url?: string | null; quote?: string } } | null
    )?.source;
    if (e.step !== "context" || !source?.kind || !kinds[source.kind]) continue;
    recorded = true;
    groups[kinds[source.kind] as string]?.push({
      title: source.title ?? "",
      url: source.url ?? null,
      quote: source.quote ?? null,
    });
  }
  if (!recorded)
    for (const e of sheet.events) {
      const detail = (e.payload as { detail?: unknown } | null)?.detail;
      if (e.step === "agent" && typeof detail === "string")
        for (const m of detail.matchAll(/lookup_docs\(\{"query":"((?:[^"\\]|\\.)*)"/g))
          groups["Docs answers"]?.push({ title: m[1] ?? "", url: null, quote: null });
    }
  return Object.entries(groups).filter(([, items]) => items.length);
}

/**
 * The clock for a run still working, read only in the browser: the server's render and the page's
 * first render show the same text (no hydration mismatch), then it ticks each second.
 */
export function useNow(ticking: boolean) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** How long a run has taken: to its end, or to now once the browser has a clock. */
export function elapsed(from: string | null, to: string | null, now: number | null) {
  if (!from) return null;
  const end = to ? Date.parse(to) : now;
  return end === null ? null : end - Date.parse(from);
}

/** The run's state in words, with why it waits or who stopped it. */
function statusOf(run: RunSheetData["run"]): { label: string; tone: Tone } {
  switch (run.status) {
    case "queued":
      return run.step && run.step !== "queued"
        ? { label: `Queued: ${run.step}`, tone: "attention" }
        : { label: "Queued", tone: "neutral" };
    case "running":
      return { label: STEP_DOING[run.step ?? ""] ?? "Running", tone: "signal" };
    case "stopping":
      return { label: run.cancelledBy ? `Stopping for @${run.cancelledBy}` : "Stopping", tone: "signal" };
    case "succeeded":
      return { label: "Finished", tone: "neutral" };
    case "cancelled":
      return {
        label: run.cancelledBy
          ? `Cancelled by @${run.cancelledBy}`
          : `Cancelled: ${run.step ?? "no reason recorded"}`,
        tone: "neutral",
      };
    default:
      return run.prMode === "issue"
        ? { label: "Needs a person", tone: "broke" }
        : { label: run.step === "interrupted" ? "Interrupted: it starts over" : "Failed", tone: "broke" };
  }
}

/**
 * The header's facts (plan revision 3.3, U2): state, evidence, where it ran, how long and what the
 * models cost; the PR or issue is the header's own button.
 */
export function RunFacts({ sheet }: { sheet: RunSheetData }) {
  const { run } = sheet;
  const status = statusOf(run);
  const began = firstStart(sheet);
  const now = useNow(!run.finishedAt);
  const ms = elapsed(began, run.finishedAt, now);
  const cost = Number(run.costUsd);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px] text-ink-3">
      {/* A finished run's verdict is its evidence chip; the word alone says it ended. */}
      {run.status === "succeeded" ? (
        <span className="text-ink-2">{status.label}</span>
      ) : (
        <StatusChip tone={status.tone}>{status.label}</StatusChip>
      )}
      {run.evidenceKind ? <EvidenceChip kind={run.evidenceKind} /> : null}
      {run.backend ? <span>{backendName(run.backend)}</span> : null}
      {ms !== null ? <span>{duration(ms)}</span> : null}
      <span>{cost > 0 ? `$${cost.toFixed(3)} in model calls` : "no model calls"}</span>
    </div>
  );
}

/** The agent's plan as it last set it (Factory's plan row): counts, done items struck through. */
function PlanBlock({ plan }: { plan: PlanItem[] }) {
  const count = (status: PlanItem["status"]) => plan.filter((i) => i.status === status).length;
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-sunken px-3 py-2 ring-1 ring-rule ring-inset">
      <span className="flex items-center gap-2 font-mono text-[11px] text-ink-3">
        <ListChecks className="size-3.5" aria-hidden />
        Plan · {count("done")} done · {count("in_progress")} in progress · {count("pending")} pending
      </span>
      <ol className="flex flex-col gap-0.5 pl-5 text-xs">
        {plan.map((i, n) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: the plan's order is its identity
            key={n}
            className={cn(
              "list-decimal",
              i.status === "done"
                ? "text-ink-3 line-through"
                : i.status === "in_progress"
                  ? "text-signal"
                  : "text-ink-2",
            )}
          >
            {i.text}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** An edit's old and new text, a few lines each (the run's full change is under Changes). */
function MiniDiff({ removed, added }: { removed: string; added: string }) {
  const lines = (text: string) => text.split("\n").slice(0, 6);
  return (
    <pre className="ml-5 overflow-x-auto rounded-md bg-sunken py-1 font-mono text-[11px] leading-5 ring-1 ring-rule ring-inset">
      {lines(removed).map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static excerpt; line order is the identity
        <span key={`r${i}`} className="block bg-affected-soft px-2 text-affected">
          − {l}
        </span>
      ))}
      {lines(added).map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static excerpt; line order is the identity
        <span key={`a${i}`} className="block bg-clear-soft px-2 text-clear">
          + {l}
        </span>
      ))}
    </pre>
  );
}

/**
 * A finished run's last word (Factory's closing artifact card): what it opened, its evidence, the
 * tests before and after, and the agent's own summary when it gave one.
 */
export function Closing({ sheet }: { sheet: RunSheetData }) {
  const { run, artifact, verification } = sheet;
  const finish = [...sheet.events]
    .reverse()
    .map(
      (e) =>
        e.payload as { calls?: { name: string; input?: { summary?: string } }[]; detail?: string } | null,
    )
    .map(
      (p) =>
        p?.calls?.find((c) => c.name === "finish")?.input?.summary ??
        /^finish\(\{"summary":"((?:[^"\\]|\\.)*)/.exec(p?.detail ?? "")?.[1],
    )
    .find(Boolean);
  const test = (side?: { name: string; counts?: { passed: number; collected: number } | null }[]) =>
    side?.find((c) => c.name === "test")?.counts;
  const before = test(verification?.baseline);
  const after = test(verification?.after);
  if (!artifact && !run.evidenceKind) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-rule px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        {run.evidenceKind ? <EvidenceChip kind={run.evidenceKind} /> : null}
        {before && after ? (
          <span className="font-mono text-xs text-ink-2">
            tests {before.passed}/{before.collected} → {after.passed}/{after.collected}
          </span>
        ) : null}
        {artifact?.url ? (
          <a
            href={artifact.url}
            className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-ink hover:underline"
          >
            {artifact.kind === "issue" ? "Issue" : "Pull request"} #{artifact.number}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        ) : null}
      </div>
      {finish ? <p className="text-sm leading-relaxed text-ink-2">{finish.replace(/\\n/g, " ")}</p> : null}
    </div>
  );
}
