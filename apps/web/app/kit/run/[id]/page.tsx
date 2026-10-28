import {
  ArrowRight,
  ChevronRight,
  ExternalLink,
  FileCode2,
  FilePen,
  Flag,
  FlaskConical,
  RotateCcw,
  Search,
  Share2,
  SquareTerminal,
} from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { DiffView } from "@/components/run/diff-view";
import { KitShell } from "@/components/teire/kit-shell";
import { type LedgerCheck, notCoveredFrom } from "@/components/teire/ledger";
import { Mark } from "@/components/teire/mark";
import { type Phase, PhaseStrip } from "@/components/teire/phase-strip";
import { ProofChain } from "@/components/teire/proof-chain";
import { EvidenceChip } from "@/components/teire/status-chip";
import { AgentTrace } from "@/components/ui/agent-trace";
import { Button } from "@/components/ui/button";
import { type ActivityRow, activityOf, type Exec } from "@/lib/activity";
import { SPONSORS } from "@/lib/brands";
import { type KitRun, kitRun, kitShell, requireKit } from "@/lib/kit";
import { subjectMark } from "@/lib/marks";
import { traceOf } from "@/lib/trace";
import { backendName, cn } from "@/lib/utils";

export const metadata = { title: "Run" };

export default function KitRunPage({ params }: PageProps<"/kit/run/[id]">) {
  return (
    <Suspense fallback={<div className="m-8 h-96 animate-pulse rounded-xl bg-sheet shadow-card" />}>
      <RunSheet params={params} />
    </Suspense>
  );
}

const duration = (ms: number | null) =>
  ms === null
    ? "—"
    : ms < 60_000
      ? `${Math.round(ms / 1000)}s`
      : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

/** The run's subject: a package and its versions, or the models a swap replaces. */
function subjectOf(run: KitRun["run"]) {
  const [head, ...rest] = (run.groupKey ?? "").split("/");
  const api = head === "models" || head === "api";
  return {
    kind: api ? (head === "models" ? "Model retirement" : "API change") : "Package upgrade",
    name: api ? (rest[0] ?? "") : rest.slice(0, -1).join("/"),
    from: (run.fromVersion ?? "").split(", ").filter(Boolean),
    to: (run.targetVersion ?? "").split(", ").filter(Boolean),
  };
}

/** Where the run's time went, from its own records. */
function phasesOf(data: KitRun): Phase[] {
  const { run, events, execs } = data;
  const sum = (phases: string[]) =>
    execs.filter((x) => phases.includes(x.phase)).reduce((n, x) => n + (x.durationMs ?? 0), 0);
  const failed = (phases: string[]) =>
    execs.some((x) => phases.includes(x.phase) && (x.timedOut || (x.exitCode ?? 0) !== 0));
  const span = (steps: string[]) => {
    const at = events.filter((e) => steps.includes(e.step)).map((e) => e.at.getTime());
    return at.length ? Math.max(...at) - Math.min(...at) : null;
  };
  const active = run.status === "running";
  const queued = run.startedAt ? run.startedAt.getTime() - run.createdAt.getTime() : null;
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
      ms: sum(["install_baseline", "baseline"]) || null,
      state: state(sum(["install_baseline", "baseline"]) || null, failed(["install_baseline", "baseline"])),
    },
    { key: "fix", label: "Fix", ms: fix, state: state(fix) },
    {
      key: "checks",
      label: "Your checks",
      ms: sum(["install_after", "after"]) || null,
      state: state(sum(["install_after", "after"]) || null, failed(["install_after", "after"])),
    },
    {
      key: "pr",
      label: data.artifact?.kind === "issue" ? "Issue" : "PR",
      ms: pr ? 600 : null,
      state: pr ? "done" : active ? "pending" : "skipped",
    },
  ];
}

async function RunSheet({ params }: { params: PageProps<"/kit/run/[id]">["params"] }) {
  const { id } = await params;
  await connection();
  await requireKit();
  const [data, shell] = await Promise.all([kitRun(id), kitShell()]);
  if (!data) return <p className="p-8 text-sm text-ink-3">No public run with that id.</p>;
  const { run, repo, artifact, events, execs, calls, verification, proof } = data;
  const active = run.status === "queued" || run.status === "running";
  const subject = subjectOf(run);
  const rows = activityOf(events, execs as Exec[], active);
  const baseline = (verification?.baseline ?? []) as LedgerCheck[];
  const after = (verification?.after ?? []) as LedgerCheck[];
  const ms = run.startedAt ? (run.finishedAt ?? new Date()).getTime() - run.startedAt.getTime() : null;
  const sandboxMs = execs.reduce((n, x) => n + (x.durationMs ?? 0), 0);
  const spans = traceOf(events, execs, calls, run.startedAt);
  const traceEnd = Math.max(1000, ...spans.map((s) => s.end));
  const tokens = calls.reduce((n, c) => n + c.tokensIn + c.tokensOut, 0);
  const test = after.find((c) => c.name === "test")?.counts;
  const testBefore = baseline.find((c) => c.name === "test")?.counts;
  const checks = [...new Set([...baseline, ...after].map((c) => c.name))];
  const notCovered = notCoveredFrom(baseline, after, verification?.reasons ?? []);

  return (
    <KitShell
      account={shell.account}
      repos={shell.repos}
      crumbs={[
        { label: repo.fullName.split("/")[1] ?? repo.fullName, href: `/kit/repo/${repo.fullName}` },
        { label: "Runs", href: "/kit/runs" },
        { label: run.id.slice(0, 8) },
      ]}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex animate-enter flex-wrap items-start justify-between gap-6">
          <div className="flex min-w-0 items-start gap-4">
            <Mark brand={subjectMark(run.groupKey)} size="lg" />
            <div className="flex min-w-0 flex-col gap-2">
              <span className="eyebrow flex items-center gap-2">
                {active ? <span className="size-1.5 rounded-full bg-signal animate-live" /> : null}
                {run.kind === "dry_run" ? "Dry run" : "Fix run"} · {subject.kind}
              </span>
              <h1 className="heading truncate text-3xl text-ink">{subject.name}</h1>
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
                {subject.from.slice(0, 3).map((v) => (
                  <span
                    key={v}
                    className="rounded-md bg-sunken px-2 py-1 text-ink-3 line-through decoration-ink-3/40 ring-1 ring-rule ring-inset"
                  >
                    {v}
                  </span>
                ))}
                {subject.from.length > 3 ? (
                  <span className="text-ink-3">+{subject.from.length - 3}</span>
                ) : null}
                <ArrowRight className="mx-1 size-3.5 text-ink-3" aria-hidden />
                {subject.to.slice(0, 3).map((v) => (
                  <span
                    key={v}
                    className="rounded-md bg-sheet px-2 py-1 text-ink ring-1 ring-rule-strong ring-inset"
                  >
                    {v}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={active}>
              <RotateCcw data-icon="inline-start" />
              Re-verify
            </Button>
            <Button variant="outline" size="sm">
              <Share2 data-icon="inline-start" />
              Share
            </Button>
            {artifact?.url ? (
              <Button size="sm" asChild>
                <a href={artifact.url}>
                  {artifact.kind === "issue" ? "Issue" : "Pull request"} #{artifact.number}
                  <ExternalLink data-icon="inline-end" />
                </a>
              </Button>
            ) : null}
          </div>
        </header>

        <section className="flex animate-enter flex-col gap-6 rounded-xl bg-sheet px-6 pt-6 pb-5 shadow-card [animation-delay:60ms]">
          <ProofChain proof={proof} />
          <div className="border-t border-rule pt-4">
            <PhaseStrip phases={phasesOf(data)} />
          </div>
        </section>

        {run.error ? (
          <p className="rounded-lg bg-broke-soft px-4 py-3 font-mono text-xs text-broke">{run.error}</p>
        ) : null}

        <div className="grid animate-enter items-start gap-6 [animation-delay:120ms] lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
          <div className="flex min-w-0 flex-col gap-6">
            <section className="flex flex-col gap-3">
              <h2 className="eyebrow">Trace</h2>
              <AgentTrace
                spans={spans}
                duration={traceEnd}
                runId={run.id.slice(0, 8)}
                model="Nemotron 3 Ultra"
                defaultTime={traceEnd}
                autoPlay={false}
                speed={Math.max(1, traceEnd / 8000)}
                labelWidth={220}
              />
            </section>
            <details className="group rounded-xl bg-sheet shadow-card">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span className="eyebrow">Steps and sandbox output</span>
                <ChevronRight
                  className="size-4 text-ink-3 transition-transform group-open:rotate-90"
                  aria-hidden
                />
              </summary>
              <ol className="divide-y divide-rule border-t border-rule">
                {rows.map((row, i) => (
                  <ActivityItem
                    key={row.key}
                    row={row}
                    open={row.state === "live" || (!active && i === rows.length - 1)}
                  />
                ))}
              </ol>
            </details>
            {run.diff ? (
              <section className="flex flex-col gap-3">
                <h2 className="eyebrow">Changes</h2>
                <div className="rounded-xl bg-sheet p-4 shadow-card">
                  <DiffView patch={run.diff} />
                </div>
              </section>
            ) : null}
          </div>

          <aside className="flex flex-col gap-4 lg:sticky lg:top-16">
            <section className="flex flex-col gap-4 rounded-xl bg-sheet p-5 shadow-card">
              <div className="flex items-center justify-between">
                <span className="eyebrow">Proof</span>
                <EvidenceChip kind={run.evidenceKind} />
              </div>
              {test ? (
                <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="eyebrow">Before</span>
                    <span className="font-mono text-3xl leading-none text-ink tabular-nums">
                      {testBefore ? `${testBefore.passed}/${testBefore.collected}` : "—"}
                    </span>
                  </div>
                  <ArrowRight className="mb-1.5 size-4 text-ink-3" aria-hidden />
                  <div className="flex flex-col gap-1">
                    <span className="eyebrow">After</span>
                    <span
                      className={cn(
                        "font-mono text-3xl leading-none tabular-nums",
                        test.failed
                          ? "text-broke"
                          : run.evidenceKind === "verified"
                            ? "text-proven"
                            : "text-ink",
                      )}
                    >
                      {test.passed}/{test.collected}
                    </span>
                  </div>
                </div>
              ) : null}
              <ul className="flex flex-col gap-1.5">
                {checks.map((name) => {
                  const b = baseline.find((c) => c.name === name);
                  const a = after.find((c) => c.name === name);
                  const pass = (c?: LedgerCheck) => !!c && c.exitCode === 0 && !c.timedOut;
                  return (
                    <li key={name} className="flex items-center justify-between font-mono text-xs">
                      <span className="text-ink-2">{name}</span>
                      <span className="flex items-center gap-2">
                        <span className={pass(b) ? "text-ink-2" : "text-broke"}>
                          {b ? (pass(b) ? "✓" : "✕") : "–"}
                        </span>
                        <ArrowRight className="size-3 text-ink-3" aria-hidden />
                        <span className={pass(a) ? "text-proven" : "text-broke"}>
                          {a ? (pass(a) ? "✓" : "✕") : "–"}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {notCovered.length ? (
                <p className="border-t border-rule pt-3 text-xs text-ink-3">
                  <span className="eyebrow mr-1.5">Not covered</span>
                  {notCovered.join("; ")}
                </p>
              ) : null}
            </section>
            <section className="flex flex-col gap-3 rounded-xl bg-sheet p-5 shadow-card">
              <span className="eyebrow">Receipt</span>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <BrandLogo
                    light={SPONSORS.nvidia.light}
                    dark={SPONSORS.nvidia.dark}
                    alt="NVIDIA"
                    className="h-3.5"
                  />
                  <span className="text-xs text-ink-2">Nemotron · {calls.length} calls</span>
                </span>
                <span className="font-mono text-xs text-ink">${Number(run.costUsd).toFixed(3)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <BrandLogo
                    light={SPONSORS.nebius.light}
                    dark={SPONSORS.nebius.dark}
                    alt="Nebius"
                    className="h-3"
                  />
                  <span className="text-xs text-ink-2">
                    {backendName(run.backend).replace("Token Factory ", "")}
                  </span>
                </span>
                <span className="font-mono text-xs text-ink">{duration(sandboxMs)}</span>
              </div>
              <div className="flex items-center justify-between border-t border-rule pt-3 font-mono text-[11px] text-ink-3">
                <span>{tokens.toLocaleString("en")} tokens</span>
                <span>{duration(ms)} total</span>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </KitShell>
  );
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

function ActivityItem({ row, open }: { row: ActivityRow; open: boolean }) {
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
          <span
            className={cn("min-w-0 flex-1 truncate text-sm", row.state === "live" ? "text-ink" : "text-ink")}
          >
            {row.title}
          </span>
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
            {row.tools.length ? (
              <ul className="mt-1 flex flex-col gap-1">
                {row.tools.map((t) => {
                  const Icon = TOOL_ICON[t.tool] ?? SquareTerminal;
                  return (
                    <li key={t.seq} className="flex items-center gap-2 text-xs">
                      <Icon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-mono text-ink-2">{t.said}</span>
                      {t.ms ? (
                        <span className="font-mono text-[11px] text-ink-3">{(t.ms / 1000).toFixed(1)} s</span>
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

/** One sandbox command: the phase dim, the command in ink mono, its exit and time; output on open. */
function Terminal({ exec }: { exec: Exec }) {
  const ok = exec.exitCode === 0 && !exec.timedOut;
  const out = `${exec.stdoutTail ?? ""}${exec.stderrTail ? `\n${exec.stderrTail}` : ""}`.trim();
  return (
    <details className="group/t mt-1 rounded-md bg-sunken ring-1 ring-rule ring-inset">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-mono text-[11px] [&::-webkit-details-marker]:hidden">
        <span className="text-ink-3">{exec.phase.replace(/_/g, " ")}</span>
        <span className="min-w-0 flex-1 truncate text-ink">$ {exec.command}</span>
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
