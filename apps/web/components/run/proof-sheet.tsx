"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ActionButton } from "@/components/app/action-button";
import { BrandLogo } from "@/components/brand-logo";
import { Markdown } from "@/components/markdown";
import { DiffView } from "@/components/run/diff-view";
import { Receipt } from "@/components/run/receipt";
import { Ledger, type LedgerCheck, notCoveredFrom } from "@/components/teire/ledger";
import { Mark } from "@/components/teire/mark";
import { PhaseStrip } from "@/components/teire/phase-strip";
import { ProofChain } from "@/components/teire/proof-chain";
import { EvidenceChip } from "@/components/teire/status-chip";
import { AgentTrace } from "@/components/ui/agent-trace";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { activityOf, type Exec, modelLabel } from "@/lib/activity";
import { SPONSORS } from "@/lib/brands";
import { subjectMark } from "@/lib/marks";
import { proofOfRun } from "@/lib/proof";
import type { RunSheetData, RunSheetTick } from "@/lib/run-sheet";
import { traceOf } from "@/lib/trace";
import { backendName, cn } from "@/lib/utils";
import { ShareRun } from "./share-run";
import {
  ActivityItem,
  Closing,
  contextOf,
  duration,
  elapsed,
  firstStart,
  liveLedger,
  phasesOf,
  RunFacts,
  subjectOf,
  useNow,
} from "./sheet-parts";

/** One poll a second while the run works, every five after ten minutes, none while hidden (D122). */
const FAST_MS = 1000;
const SLOW_MS = 5000;
const SLOW_AFTER_MS = 10 * 60_000;
const FINAL_EVENTS_MS = 15_000;

const ACTIVE = new Set(["queued", "running", "stopping"]);

/**
 * The run proof sheet (plan revision 3.3, U2): what changed, where it reaches the code, what was
 * fixed, what proves it and what wasn't proven, readable in ten seconds, and live from start to
 * finish without a reload: one poll feeds every section.
 */
export function ProofSheet({ initial }: { initial: RunSheetData }) {
  const client = useQueryClient();
  const [opened] = useState(() => Date.now());
  const key = ["run-sheet", initial.run.id];
  const {
    data: sheet,
    failureCount,
    error,
  } = useQuery({
    queryKey: key,
    initialData: initial,
    // A tick: one query for what moves (the run, its PR, the events after the last held, receipts);
    // the diff only when it changed. A failed tick keeps the last data and says "Reconnecting…".
    queryFn: async () => {
      const held = client.getQueryData<RunSheetData>(key) ?? initial;
      const after = held.events.at(-1)?.seq ?? 0;
      const res = await fetch(`/api/runs/${initial.run.id}/sheet?after=${after}&dh=${held.run.diffHash}`, {
        cache: "no-store",
      });
      if (res.status === 404) throw new Error("gone");
      if (!res.ok) throw new Error("unreachable");
      const tick = (await res.json()) as RunSheetTick;
      const seen = new Set(held.events.map((e) => e.seq));
      return {
        ...held,
        ...tick,
        run: { ...tick.run, diff: tick.run.diff !== undefined ? tick.run.diff : held.run.diff },
        events: [...held.events, ...tick.events.filter((e) => !seen.has(e.seq))],
      };
    },
    retry: false,
    // A run's last events land just after its final status (U2 review), so the poll runs a little past it.
    refetchInterval: (q) => {
      const run = q.state.data?.run;
      if (ACTIVE.has(run?.status ?? "")) return Date.now() - opened > SLOW_AFTER_MS ? SLOW_MS : FAST_MS;
      return run?.finishedAt && Date.now() - Date.parse(run.finishedAt) < FINAL_EVENTS_MS ? FAST_MS : false;
    },
  });

  const { run, repo, artifact, verification } = sheet;
  const active = ACTIVE.has(run.status);
  const model = sheet.calls.find((c) => c.purpose === "fix")?.model ?? sheet.calls[0]?.model ?? null;
  const events = sheet.events.map((e) => ({ ...e, at: new Date(e.at) }));
  const execs: Exec[] = sheet.execs.map((x) => ({ ...x, stderrTail: null }));
  // When work first began: a restarted run's `startedAt` is its latest start, so its first attempt
  // would fold into the wait (U2 review).
  const began = firstStart(sheet);
  // The first wait runs from when the run was queued to when work began, as the phase strip counts it.
  const rows = activityOf(events, execs, active, model).map((r, i, all) =>
    r.step === "queue" && began && all.findIndex((x) => x.step === "queue") === i
      ? { ...r, startedAt: new Date(run.createdAt), endedAt: new Date(began) }
      : r,
  );
  const spans = traceOf(
    events,
    sheet.execs.map((x) => ({ ...x, createdAt: new Date(x.createdAt) })),
    sheet.calls.map((c) => ({ ...c, createdAt: new Date(c.createdAt) })),
    began ? new Date(began) : null,
  );
  const traceEnd = Math.max(1000, ...spans.map((s) => s.end));
  const subject = subjectOf(run);
  const proof = proofOfRun({
    kind: run.kind,
    status: run.status,
    step: run.step,
    evidenceKind: run.evidenceKind,
    prMode: run.prMode,
    sites: sheet.reach.sites,
    advisory: sheet.reach.advisory,
    artifact: artifact ? { kind: artifact.kind, url: artifact.url, number: artifact.number } : null,
  });
  // Until the run stores its checks, the ledger fills from each check's log line as it finishes.
  const live = verification?.baseline ? null : liveLedger(sheet.events);
  const baseline = (verification?.baseline ?? live?.baseline ?? []) as LedgerCheck[];
  const after = (verification?.after ?? live?.after ?? []) as LedgerCheck[];
  const notCovered = notCoveredFrom(baseline, after, verification?.reasons ?? []);
  const test = after.find((c) => c.name === "test")?.counts;
  const testBefore = baseline.find((c) => c.name === "test")?.counts;
  const now = useNow(active);
  const ms = elapsed(run.startedAt, run.finishedAt, now);
  const sandboxMs = sheet.execs.reduce((n, x) => n + (x.durationMs ?? 0), 0);
  const tokens = sheet.calls.reduce((n, c) => n + c.tokensIn + c.tokensOut, 0);
  const context = contextOf(sheet);
  const dry = run.kind === "dry_run";
  // Under Off a base move leaves the PR as it was (D125): its evidence is from an older base until
  // a re-verify (which then holds the PR) checks it again.
  const stale =
    artifact?.kind === "pr" && artifact.state === "open" && artifact.runId === run.id
      ? (sheet.events.findLast((e) => e.step === "pr" && e.type === "stale-evidence")?.payload as
          | { base?: string; reason?: string }
          | undefined)
      : undefined;
  const stopping = [...sheet.events].reverse().find((e) => e.step === "run" && e.type === "stopping")
    ?.payload as { during?: string; doing?: string | null } | undefined;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex animate-enter flex-wrap items-start justify-between gap-6">
        <div className="flex min-w-0 items-start gap-4">
          <Mark brand={subjectMark(run.groupKey)} size="lg" />
          <div className="flex min-w-0 flex-col gap-2">
            <span className="eyebrow flex flex-wrap items-center gap-2">
              {active ? <span className="size-1.5 rounded-full bg-signal animate-live" /> : null}
              <a href={`https://github.com/${repo.fullName}`} className="hover:text-ink">
                {repo.fullName}
              </a>
              <span>·</span>
              {dry ? "Dry run" : run.kind === "reverify" ? "Re-verify" : "Fix run"} · {subject.kind}
              {sheet.report ? (
                <Link
                  href={`/scan/${sheet.report}`}
                  className="normal-case tracking-normal text-ink-2 hover:text-ink"
                >
                  ← the report
                </Link>
              ) : null}
            </span>
            <h1 className="heading truncate text-3xl text-ink">{subject.name || run.groupKey}</h1>
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
            <RunFacts sheet={sheet} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sheet.member && active ? (
            <ActionButton
              kind="cancel-run"
              params={{ runId: run.id }}
              repo={repo.fullName}
              disabled={run.status === "stopping"}
            >
              {run.status === "stopping" ? "Stopping…" : "Cancel"}
            </ActionButton>
          ) : null}
          {sheet.member &&
          (run.status === "failed" || run.status === "cancelled") &&
          run.kind !== "reverify" ? (
            <ActionButton kind="retry-run" params={{ runId: run.id }} repo={repo.fullName}>
              Retry
            </ActionButton>
          ) : null}
          {/* A re-verify is retried by re-verifying: the PR's code is never rebuilt from it. */}
          {sheet.member && !active && artifact?.kind === "pr" && artifact.state === "open" ? (
            <ActionButton kind="reverify-run" params={{ runId: run.id }} repo={repo.fullName}>
              Re-verify
            </ActionButton>
          ) : null}
          {sheet.member &&
          !active &&
          run.prMode === "issue" &&
          run.diff &&
          !(artifact?.kind === "pr" && artifact.state === "open") ? (
            <ActionButton kind="open-draft-anyway" params={{ runId: run.id }} repo={repo.fullName}>
              Open draft anyway
            </ActionButton>
          ) : null}
          <ShareRun
            runId={run.id}
            isPrivate={repo.isPrivate}
            rerun={
              !sheet.member || active ? (
                dry && sheet.report ? (
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/scan/${sheet.report}`}>Dry-run again from the report</a>
                  </Button>
                ) : null
              ) : artifact?.kind === "pr" && artifact.state === "open" ? (
                <ActionButton kind="reverify-run" params={{ runId: run.id }} repo={repo.fullName}>
                  Re-run its checks
                </ActionButton>
              ) : (run.status === "failed" || run.status === "cancelled") && run.kind === "fix" ? (
                <ActionButton kind="retry-run" params={{ runId: run.id }} repo={repo.fullName}>
                  Run it again
                </ActionButton>
              ) : null
            }
          />
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
          <PhaseStrip phases={phasesOf(sheet)} />
        </div>
      </section>

      {failureCount > 0 ? (
        <p className="rounded-lg bg-sunken px-4 py-2 font-mono text-xs text-ink-3" role="status">
          {error?.message === "gone"
            ? "This run is no longer visible to you: its repository may have turned private. What's shown is from before."
            : "Reconnecting… the page keeps what it last read."}
        </p>
      ) : null}
      {run.status === "stopping" ? (
        <p className="rounded-lg bg-signal-soft px-4 py-3 text-sm text-signal">
          Stopping: {run.cancelledBy ? `@${run.cancelledBy} asked` : "asked"} during{" "}
          {stopping?.during ?? run.step ?? "its work"}
          {stopping?.doing ? <span className="font-mono text-xs"> ({stopping.doing})</span> : null}. Its model
          calls, updater job and sandbox commands are being stopped; this takes up to 30 seconds.
        </p>
      ) : stale ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-attention-soft px-4 py-3 text-sm text-attention">
          <p>
            Evidence is from an older base: the base branch moved
            {stale.base ? <span className="font-mono text-xs"> ({stale.base})</span> : null} while fixes are
            off. Re-verify checks it merged into the base as it is now.
          </p>
          {sheet.member ? (
            <ActionButton kind="reverify-run" params={{ runId: run.id }} repo={repo.fullName}>
              Re-verify
            </ActionButton>
          ) : null}
        </div>
      ) : run.error ? (
        <p className="rounded-lg bg-broke-soft px-4 py-3 font-mono text-xs text-broke">{run.error}</p>
      ) : null}

      <div className="grid animate-enter grid-cols-1 items-start gap-6 [animation-delay:120ms] *:min-w-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <div className="flex min-w-0 flex-col gap-6">
          <section className="flex flex-col gap-3">
            <h2 className="eyebrow">Trace</h2>
            {spans.length ? (
              <AgentTrace
                spans={spans}
                duration={traceEnd}
                runId={run.id.slice(0, 8)}
                model={modelLabel(model) ?? undefined}
                live={active}
                defaultTime={traceEnd}
                autoPlay={false}
                speed={Math.max(1, traceEnd / 8000)}
                labelWidth={220}
              />
            ) : (
              <p className="rounded-xl bg-sheet px-4 py-6 text-sm text-ink-3 shadow-card">
                {active ? "Connecting to the sandbox…" : "Nothing was recorded for this run."}
              </p>
            )}
          </section>
          <section className="rounded-xl bg-sheet shadow-card">
            <h2 className="eyebrow px-4 pt-3 pb-2">Steps</h2>
            <ol className="divide-y divide-rule border-t border-rule">
              {rows.map((row, i) => (
                <ActivityItem
                  key={row.key}
                  row={row}
                  open={row.state === "live" || (!active && i === rows.length - 1)}
                />
              ))}
            </ol>
            {!active ? <Closing sheet={sheet} /> : null}
          </section>
          {run.diff ? (
            <section className="flex flex-col gap-3">
              <h2 className="eyebrow">Changes</h2>
              <div className="rounded-xl bg-sheet p-4 shadow-card">
                <DiffView patch={run.diff} />
              </div>
            </section>
          ) : null}
          {dry && sheet.preview?.body ? (
            <section className="flex flex-col gap-3">
              <h2 className="eyebrow">
                {sheet.preview.mode === "issue" ? "The issue" : "The PR"}, as GitHub would show it
              </h2>
              <article className="rounded-xl bg-sheet p-5 shadow-card">
                {sheet.preview.title ? (
                  <h3 className="mb-3 text-lg font-medium">{sheet.preview.title}</h3>
                ) : null}
                <Markdown>{sheet.preview.body}</Markdown>
              </article>
            </section>
          ) : null}
          <details className="rounded-xl bg-sheet shadow-card">
            <summary className="cursor-pointer px-4 py-3 eyebrow">Receipt</summary>
            <div className="border-t border-rule p-4">
              <Receipt calls={sheet.calls} execs={sheet.execs} total={Number(run.costUsd)} />
            </div>
          </details>
          <details className="rounded-xl bg-sheet shadow-card">
            <summary className="cursor-pointer px-4 py-3 eyebrow">Raw events ({sheet.events.length})</summary>
            <pre className="max-h-96 overflow-auto border-t border-rule p-4 font-mono text-[11px] leading-relaxed text-ink-2">
              {sheet.events
                .map((e) => `${e.seq} ${e.at.slice(11, 19)} ${e.step} ${e.type} ${JSON.stringify(e.payload)}`)
                .join("\n")}
            </pre>
          </details>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-16">
          <Tabs defaultValue="proof" className="gap-3">
            <TabsList>
              <TabsTrigger value="proof">Proof</TabsTrigger>
              <TabsTrigger value="context">
                Context{context.length ? ` (${context.reduce((n, [, l]) => n + l.length, 0)})` : ""}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="proof" className="flex flex-col gap-4">
              <section className="flex flex-col gap-4 rounded-xl bg-sheet p-5 shadow-card">
                <div className="flex items-center justify-between">
                  <span className="eyebrow">Proof</span>
                  {run.evidenceKind ? <EvidenceChip kind={run.evidenceKind} /> : null}
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
                {baseline.length || after.length ? (
                  <Ledger
                    baseline={baseline}
                    after={after}
                    evidence={run.evidenceKind}
                    verdict={verification?.reasons?.[0] ?? ""}
                    notCovered={notCovered}
                    live={!!live && active}
                  />
                ) : (
                  <p className="text-sm text-ink-3">
                    {active ? "The checks run before and after the change." : "No checks ran."}
                  </p>
                )}
              </section>
              {verification?.others?.length ? (
                <section className="flex flex-col gap-3 rounded-xl bg-sheet p-5 shadow-card">
                  <span className="eyebrow">Other projects the change touched</span>
                  <ul className="flex flex-col gap-3">
                    {verification.others.map((o) => (
                      <li key={`${o.ecosystem}:${o.root}`} className="flex flex-col gap-2">
                        <span className="font-mono text-xs text-ink">
                          {o.root === "." ? "(root)" : o.root} · {o.ecosystem}
                        </span>
                        {/* Each project its own ledger rows (D94), even one that couldn't be checked. */}
                        <Ledger
                          baseline={o.baseline as LedgerCheck[]}
                          after={o.after as LedgerCheck[]}
                          evidence={o.evidence}
                          verdict={o.reasons[0] ?? ""}
                          notCovered={notCoveredFrom(
                            o.baseline as LedgerCheck[],
                            o.after as LedgerCheck[],
                            o.reasons,
                          )}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
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
                    <span className="text-xs text-ink-2">
                      {modelLabel(model) ?? "Models"} · {sheet.calls.length} calls
                    </span>
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
            </TabsContent>
            <TabsContent value="context" className="flex flex-col gap-3">
              {context.length ? (
                context.map(([group, items]) => (
                  <section key={group} className="flex flex-col gap-2 rounded-xl bg-sheet p-4 shadow-card">
                    <span className="eyebrow">
                      {group} ({items.length})
                    </span>
                    <ul className="flex flex-col gap-3">
                      {items.slice(0, 12).map((item, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: two sources can share a title; order is stable
                        <li key={`${item.title}-${i}`} className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-ink">
                            {item.url?.startsWith("https://") ? (
                              <a
                                href={item.url}
                                className="hover:underline"
                                rel="noreferrer noopener"
                                target="_blank"
                              >
                                {item.title}
                              </a>
                            ) : (
                              item.title
                            )}
                          </span>
                          {item.quote ? (
                            <details className="group/q">
                              <summary className="cursor-pointer list-none font-mono text-[11px] text-ink-3 [&::-webkit-details-marker]:hidden">
                                What it said
                              </summary>
                              <blockquote className="mt-1 max-h-48 overflow-auto border-l-2 border-rule pl-2 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
                                {item.quote}
                              </blockquote>
                            </details>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              ) : (
                <p className="rounded-xl bg-sheet p-4 text-sm text-ink-3 shadow-card">
                  {active
                    ? "What the run reads to decide shows here as it reads it."
                    : "This run read no release notes or provider pages."}
                </p>
              )}
            </TabsContent>
          </Tabs>
        </aside>
      </div>
    </div>
  );
}
