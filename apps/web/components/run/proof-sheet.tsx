"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ActionButton } from "@/components/app/action-button";
import { BrandLogo } from "@/components/brand-logo";
import { TileLabel, TileSquare } from "@/components/flow/tile";
import { DiffView } from "@/components/run/diff-view";
import { Receipt } from "@/components/run/receipt";
import type { LedgerCheck } from "@/components/teire/ledger";
import { notCoveredFrom } from "@/components/teire/ledger";
import { Mark } from "@/components/teire/mark";
import { AgentTrace } from "@/components/ui/agent-trace";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { activityOf, type Exec, modelLabel } from "@/lib/activity";
import { SPONSORS, STACK } from "@/lib/brands";
import { canReplay, sheetAt } from "@/lib/flow/clock";
import { type FlowTile, runFlow, TILE_OF_STEP } from "@/lib/flow/model";
import { subjectMark } from "@/lib/marks";
import { proofOfRun, STEP_DOING } from "@/lib/proof";
import { postOf } from "@/lib/run-evidence";
import type { RunSheetData, RunSheetTick } from "@/lib/run-sheet";
import { traceOf } from "@/lib/trace";
import { backendName } from "@/lib/utils";
import { Commits, EventLog, PostView } from "./evidence";
import { Inspector, type InspectorData } from "./inspector";
import { RunCanvas } from "./run-canvas";
import { ShareRun } from "./share-run";
import {
  ActivityItem,
  Closing,
  contextOf,
  duration,
  elapsed,
  firstStart,
  liveLedger,
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
 * The run page (plan revision 3.4, V3; 3.3's U2 data contract kept): a canvas of the run's tiles with
 * an inspector for the selected tile's evidence, and a console underneath (the replayable timeline,
 * steps, changes, receipt, raw events). Live from start to finish without a reload: one poll feeds
 * everything, a failed tick keeps the last data, and the poll runs a little past the final status.
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
  const _proof = proofOfRun({
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
  // The PR or issue as its text, read from the events on every poll, so it appears when the run ends.
  const post = postOf(sheet.events, artifact);
  const [tab, setTab] = useState<string | null>(null);
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

  // The run as tiles (plan revision 3.4, A2): one adapter, so the canvas, the rows and the cards agree.
  // One clock (plan revision 3.4, B5): the timeline's playhead; null rests on now / the final state.
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const moment = !active ? sheetAt(sheet.events, began, replayAt, traceEnd - 1) : null;
  const attempts = new Set(sheet.calls.filter((c) => c.purpose === "fix").map((c) => c.step)).size;
  // The run as tiles (plan revision 3.4, A2): one adapter, so the canvas, the rows and the cards agree.
  const graph = runFlow({
    kind: run.kind,
    // During a replay the canvas shows the run as it was then: on that step, before any verdict.
    status: moment ? (moment.step ? "running" : "queued") : run.status,
    step: moment ? moment.step : run.step,
    evidenceKind: moment ? null : run.evidenceKind,
    prMode: moment ? null : run.prMode,
    sites: sheet.reach.sites,
    advisory: sheet.reach.advisory,
    artifact:
      !moment && artifact ? { kind: artifact.kind, url: artifact.url, number: artifact.number } : null,
    subject: subjectMark(run.groupKey),
    // A tile holds a short name: Maven's group:artifact becomes the artifact.
    subjectLabel: (subject.name || run.groupKey || "Change").split(":").at(-1) as string,
    repo: { fullName: repo.fullName },
    agent: sheet.events.some((e) => e.step === "agent")
      ? { calls: sheet.calls.filter((c) => c.purpose === "fix").length, attempts }
      : null,
    codemod: sheet.events.some((e) => e.step === "codemod"),
    backend: run.backend,
    // Model and API changes are swaps in the code; only package changes go through the updater.
    updater: !/^(models|api)\//.test(run.groupKey ?? ""),
    lastStep: [...sheet.events].reverse().find((e) => TILE_OF_STEP[e.step])?.step ?? null,
    preview: !!post,
    checkCount: new Set(after.map((c) => c.name)).size,
    ...(test && testBefore
      ? { checksFigure: `${testBefore.passed}/${testBefore.collected} → ${test.passed}/${test.collected}` }
      : {}),
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // A trail's step links here as `?tile=…`: open that step's evidence (after hydration, so the server's
  // first paint and the client's agree).
  useEffect(() => {
    const tile = new URLSearchParams(window.location.search).get("tile");
    if (tile) setPicked(tile);
  }, []);
  const liveTile = graph.tiles.find((t) => t.state === "live")?.id;
  const selectedId =
    picked ??
    liveTile ??
    (active ? "change" : graph.tiles.some((t) => t.id === "check") ? "check" : "outcome");
  const selectedTile = graph.tiles.find((t) => t.id === selectedId) ?? (graph.tiles[0] as FlowTile);
  const caption = active && run.step ? (STEP_DOING[run.step] ?? null) : null;
  const inspector: InspectorData = {
    sheet,
    rows,
    baseline,
    after,
    notCovered,
    liveLedger: !!live && active,
    context,
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <header className="flex animate-enter flex-wrap items-start justify-between gap-6">
        <div className="flex min-w-0 items-start gap-4">
          <Mark brand={subjectMark(run.groupKey)} size="lg" />
          <div className="flex min-w-0 flex-col gap-2">
            <span className="flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
              {active ? <span className="size-1.5 rounded-full bg-signal animate-live" /> : null}
              <a href={`https://github.com/${repo.fullName}`} className="hover:text-ink">
                {repo.fullName}
              </a>
              <span aria-hidden>·</span>
              <span>{dry ? "Dry run" : run.kind === "reverify" ? "Re-verify" : "Fix run"}</span>
              {sheet.report ? (
                <Link href={`/scan/${sheet.report}`} className="text-ink-2 hover:text-ink">
                  ← the report
                </Link>
              ) : null}
            </span>
            <h1 className="heading truncate text-3xl text-ink">{subject.name || run.groupKey}</h1>
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
              {subject.from.slice(0, 3).map((v) => (
                <span
                  key={v}
                  className="rounded-full bg-sunken px-2.5 py-1 text-ink-3 line-through decoration-ink-3/40"
                >
                  {v}
                </span>
              ))}
              {subject.from.length > 3 ? (
                <span className="text-ink-3">+{subject.from.length - 3}</span>
              ) : null}
              <ArrowRight className="mx-1 size-3.5 text-ink-3" aria-hidden />
              {subject.to.slice(0, 3).map((v) => (
                <span key={v} className="rounded-full bg-sheet px-2.5 py-1 text-ink shadow-card">
                  {v}
                </span>
              ))}
            </div>
            <RunFacts sheet={sheet} />
            <Commits sheet={sheet} />
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

      {failureCount > 0 ? (
        <p className="w-fit rounded-full bg-sunken px-3 py-1 font-mono text-xs text-ink-3" role="status">
          {error?.message === "gone" ? "No longer visible to you · showing what was read" : "Reconnecting…"}
        </p>
      ) : null}
      {run.status === "stopping" ? (
        <p className="w-fit rounded-full bg-signal-soft px-3 py-1 text-[13px] text-signal" role="status">
          Stopping{run.cancelledBy ? ` for @${run.cancelledBy}` : ""}
          {stopping?.during ? ` during ${stopping.during}` : ""} · up to 30 s
        </p>
      ) : stale ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card bg-attention-soft px-4 py-2.5 text-[13px] text-attention">
          <span>Base moved{stale.base ? ` (${stale.base})` : ""} · evidence is from the older base</span>
          {sheet.member ? (
            <ActionButton kind="reverify-run" params={{ runId: run.id }} repo={repo.fullName}>
              Re-verify on the new base
            </ActionButton>
          ) : null}
        </div>
      ) : run.error ? (
        <p className="rounded-card bg-broke-soft px-4 py-3 font-mono text-xs text-broke">{run.error}</p>
      ) : null}

      {/* The canvas and its inspector (n8n's execution view). Phones get the tiles as a list. */}
      <section className="grid animate-enter overflow-hidden rounded-feature bg-sheet shadow-card [animation-delay:60ms] lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="hidden border-rule md:block max-lg:border-b lg:border-r">
          <RunCanvas
            key={graph.tiles.map((t) => t.id).join("|")}
            runId={run.id}
            graph={graph}
            selected={selectedId}
            onSelect={setPicked}
            caption={caption}
            className="h-[280px]"
          />
        </div>
        <ol className="flex flex-col p-4 md:hidden" aria-label="The run, step by step">
          {graph.tiles.map((t, i) => (
            <li key={t.id} className="flex flex-col">
              {i > 0 ? <span aria-hidden className="ml-[21px] h-4 w-px bg-rule-strong" /> : null}
              <button
                type="button"
                onClick={() => {
                  setPicked(t.id);
                  setSheetOpen(true);
                }}
                className="flex items-center gap-3 rounded-card p-1 text-left active:bg-hover"
              >
                <TileSquare tile={t} size="sm" />
                <TileLabel tile={t} size="sm" className="items-start text-left" />
              </button>
            </li>
          ))}
        </ol>
        <div className="hidden max-h-[640px] overflow-y-auto p-5 md:block">
          <Inspector tile={selectedTile} data={inspector} />
        </div>
        {/* Phones: a tile's evidence opens in a bottom sheet (plan revision 3.4, V3). */}
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent
            side="bottom"
            className="max-h-[85svh] overflow-y-auto rounded-t-feature p-5 md:hidden"
          >
            <SheetTitle className="sr-only">{selectedTile.label}</SheetTitle>
            <Inspector tile={selectedTile} data={inspector} />
          </SheetContent>
        </Sheet>
      </section>

      {/* The console (n8n's bottom panel): the timeline that replays the run, and the raw record. */}
      <section className="animate-enter rounded-feature bg-sheet p-4 shadow-card [animation-delay:120ms] sm:p-5">
        <Tabs value={tab ?? (post && !active ? "post" : "timeline")} onValueChange={setTab} className="gap-4">
          <TabsList>
            {post ? (
              <TabsTrigger value="post">
                {post.state === "proposed" ? "Proposed PR" : post.kind === "issue" ? "The issue" : "The PR"}
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="steps">Steps</TabsTrigger>
            {run.diff ? <TabsTrigger value="changes">Changes</TabsTrigger> : null}
            <TabsTrigger value="receipt">Receipt</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
          </TabsList>
          {post ? (
            <TabsContent value="post">
              <PostView post={post} />
            </TabsContent>
          ) : null}
          <TabsContent value="timeline">
            {spans.length ? (
              <AgentTrace
                onTime={canReplay(sheet.events) ? setReplayAt : undefined}
                spans={spans}
                duration={traceEnd}
                runId={run.id.slice(0, 8)}
                model={modelLabel(model) ?? undefined}
                live={active}
                // How it ended, as the header says it (Codex walk B10: an interrupted run read "Completed").
                endedAs={
                  run.status === "failed"
                    ? run.step === "interrupted"
                      ? "Interrupted"
                      : "Failed"
                    : run.status === "cancelled"
                      ? "Cancelled"
                      : "Completed"
                }
                defaultTime={traceEnd}
                autoPlay={false}
                speed={Math.max(1, traceEnd / 8000)}
                labelWidth={220}
              />
            ) : (
              <p className="py-6 text-sm text-ink-3">
                {active ? "Connecting to the sandbox…" : "Nothing recorded."}
              </p>
            )}
          </TabsContent>
          <TabsContent value="steps">
            <ol className="divide-y divide-rule overflow-hidden rounded-card shadow-card">
              {rows.map((row, i) => (
                <ActivityItem
                  key={row.key}
                  row={row}
                  open={row.state === "live" || (!active && i === rows.length - 1)}
                />
              ))}
            </ol>
            {!active ? <Closing sheet={sheet} /> : null}
          </TabsContent>
          {run.diff ? (
            <TabsContent value="changes">
              <DiffView patch={run.diff} />
            </TabsContent>
          ) : null}
          <TabsContent value="receipt" className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Fact
                mark={
                  <BrandLogo light={STACK.nemotron.light} dark={STACK.nemotron.dark} alt="" className="h-4" />
                }
                label={modelLabel(model) ?? "Models"}
                value={`${sheet.calls.length} calls · $${Number(run.costUsd).toFixed(3)}`}
              />
              <Fact
                mark={
                  <BrandLogo
                    light={SPONSORS.nebius.light}
                    dark={SPONSORS.nebius.dark}
                    alt=""
                    className="h-3"
                  />
                }
                label={backendName(run.backend).replace("Token Factory ", "")}
                value={duration(sandboxMs)}
              />
              <Fact label="Total" value={`${tokens.toLocaleString("en")} tokens · ${duration(ms)}`} />
            </div>
            <Receipt calls={sheet.calls} execs={sheet.execs} total={Number(run.costUsd)} />
          </TabsContent>
          <TabsContent value="events">
            <EventLog events={sheet.events} />
          </TabsContent>
        </Tabs>
      </section>
    </div>
  );
}

/** A receipt figure: an optional mark, what it is, and the number. */
function Fact({ mark, label, value }: { mark?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-card bg-sunken p-3">
      <span className="flex items-center gap-2 text-xs text-ink-2">
        {mark}
        {label}
      </span>
      <span className="font-mono text-sm text-ink">{value}</span>
    </div>
  );
}
