import {
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
import { DiffView } from "@/components/run/diff-view";
import { KitShell } from "@/components/teire/kit-shell";
import { Ledger, type LedgerCheck, notCoveredFrom } from "@/components/teire/ledger";
import { LiveDot } from "@/components/teire/live-dot";
import { ProofChain } from "@/components/teire/proof-chain";
import { EvidenceChip } from "@/components/teire/status-chip";
import { Surface } from "@/components/teire/surface";
import { Button } from "@/components/ui/button";
import { type ActivityRow, activityOf, type Exec } from "@/lib/activity";
import { type KitRun, kitRun, kitShell, requireKit } from "@/lib/kit";
import { backendName, cn } from "@/lib/utils";

export const metadata = { title: "Run" };

export default function KitRunPage({ params }: PageProps<"/kit/run/[id]">) {
  return (
    <Suspense fallback={<div className="m-8 h-96 animate-pulse rounded-lg bg-sheet shadow-card" />}>
      <RunSheet params={params} />
    </Suspense>
  );
}

const duration = (ms: number | null) =>
  ms === null
    ? "—"
    : ms < 60_000
      ? `${Math.round(ms / 1000)} s`
      : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

/** The run's subject: a package and its versions, or the models a swap replaces. */
function subjectOf(run: KitRun["run"]) {
  const [head, ...rest] = (run.groupKey ?? "").split("/");
  if (head === "models" || head === "api")
    return {
      kind: head === "models" ? "Model retirement" : "API change",
      name: rest[0] ?? "",
      from: run.fromVersion,
      to: run.targetVersion,
    };
  return {
    kind: "Package upgrade",
    name: rest.slice(0, -1).join("/"),
    from: run.fromVersion,
    to: run.targetVersion,
  };
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
  const byModel = new Map<string, { calls: number; cost: number }>();
  for (const c of calls) {
    const m = byModel.get(c.model) ?? { calls: 0, cost: 0 };
    byModel.set(c.model, { calls: m.calls + 1, cost: m.cost + Number(c.costUsd) });
  }
  const test = after.find((c) => c.name === "test")?.counts;
  const testBefore = baseline.find((c) => c.name === "test")?.counts;

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
        <header className="flex flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1.5">
              <p className="flex items-center gap-2">
                {active ? <LiveDot /> : null}
                <span className="eyebrow">
                  {run.kind === "dry_run" ? "Dry run" : "Fix run"} · {subject.kind}
                </span>
              </p>
              <h1 className="heading text-xl text-ink sm:text-2xl">
                <span className="font-mono">{subject.name}</span>
              </h1>
              {subject.from || subject.to ? (
                <p className="flex flex-wrap items-center gap-2 font-mono text-sm">
                  <span className="text-ink-3 line-through decoration-rule-strong">{subject.from}</span>
                  <ChevronRight className="size-3.5 text-ink-3" aria-hidden />
                  <span className="text-ink">{subject.to}</span>
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={active} title="U2">
                <RotateCcw data-icon="inline-start" />
                Re-verify
              </Button>
              <Button variant="outline" size="sm" title="U2">
                <Share2 data-icon="inline-start" />
                Share
              </Button>
              {artifact?.url ? (
                <Button size="sm" asChild>
                  <a href={artifact.url}>
                    Open {artifact.kind === "issue" ? "issue" : "PR"} #{artifact.number}
                    <ExternalLink data-icon="inline-end" />
                  </a>
                </Button>
              ) : null}
            </div>
          </div>
          <div className="rounded-lg bg-sheet px-4 pt-4 pb-3 shadow-card">
            <ProofChain proof={proof} />
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-5">
            <Fact label="Evidence">
              <EvidenceChip kind={run.evidenceKind} />
            </Fact>
            <Fact label="Sandbox">{backendName(run.backend)}</Fact>
            <Fact label="Duration">
              <span className="font-mono">{duration(ms)}</span>
            </Fact>
            <Fact label="Model cost">
              <span className="font-mono">${Number(run.costUsd).toFixed(4)}</span>
            </Fact>
            <Fact label="Repository">
              <a href={`https://github.com/${repo.fullName}`} className="entity-link font-mono text-xs">
                {repo.fullName}
              </a>
            </Fact>
          </dl>
          {run.error ? (
            <p className="rounded-md bg-broke-soft px-3 py-2 text-sm text-broke">{run.error}</p>
          ) : null}
        </header>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
          <Surface eyebrow="Activity" flush>
            <ol className="divide-y divide-rule">
              {rows.map((row, i) => (
                <ActivityItem
                  key={row.key}
                  row={row}
                  open={row.state === "live" || (!active && i === rows.length - 1)}
                />
              ))}
            </ol>
          </Surface>
          <aside className="flex flex-col gap-6 lg:sticky lg:top-16">
            <Surface eyebrow="Proof" title="Your checks, before and after" flush>
              <div className="py-3">
                <Ledger
                  baseline={baseline}
                  after={after}
                  evidence={run.evidenceKind}
                  {...(test
                    ? {
                        verdict: `tests ${testBefore ? `${testBefore.passed}/${testBefore.collected}` : "–"} → ${test.passed}/${test.collected}`,
                      }
                    : {})}
                  notCovered={notCoveredFrom(baseline, after, verification?.reasons ?? [])}
                />
              </div>
            </Surface>
            <Surface eyebrow="Receipt" flush>
              <ul className="divide-y divide-rule text-xs">
                {[...byModel].map(([model, m]) => (
                  <li key={model} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="truncate font-mono text-ink-2">{model.replace(/^nvidia\//, "")}</span>
                    <span className="shrink-0 font-mono text-ink">
                      {m.calls} call{m.calls === 1 ? "" : "s"} · ${m.cost.toFixed(4)}
                    </span>
                  </li>
                ))}
                <li className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="text-ink-2">{backendName(run.backend)}</span>
                  <span className="font-mono text-ink">
                    {execs.length} commands · {duration(sandboxMs)}
                  </span>
                </li>
              </ul>
            </Surface>
          </aside>
        </div>

        {run.diff ? (
          <Surface eyebrow="Changes" title="What the pull request changes">
            <DiffView patch={run.diff} />
          </Surface>
        ) : null}
      </div>
    </KitShell>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="eyebrow">{label}</dt>
      <dd className="min-w-0 truncate text-ink">{children}</dd>
    </div>
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
