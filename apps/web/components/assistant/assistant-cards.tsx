"use client";

import type { ActionStatus } from "@teire/engine/actions";
import { TERMINAL } from "@teire/engine/actions";
import {
  Activity,
  ArrowUpRight,
  Box,
  Check,
  Cpu,
  GitPullRequest,
  Hand,
  Loader2,
  type LucideIcon,
  MessageCircleQuestion,
  Play,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { MiniFlow } from "@/components/flow/mini-flow";
import { ReachFan } from "@/components/flow/reach-fan";
import { Trail } from "@/components/flow/trail";
import { LiveDot } from "@/components/teire/live-dot";
import { Mark } from "@/components/teire/mark";
import { EvidenceChip, StatusChip, type Tone } from "@/components/teire/status-chip";
import { Button } from "@/components/ui/button";
import type { AssistantMessage, AssistantNotice } from "@/lib/assistant/message";
import { changeBrand } from "@/lib/estate";
import { FIX_MODES } from "@/lib/fix-mode-options";
import type { FlowEntity, FlowGraph, FlowState, FlowTile } from "@/lib/flow/model";
import { subjectMark, subjectOfKey } from "@/lib/marks";
import type { Proof } from "@/lib/proof";
import { ago, until } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * Ask Teire's generative cards (plan revision 3.3, U4): each tool's result rendered as Teire's own
 * components, not as text. Every factual card says when its source was read and links to where it
 * lives in Teire. Text from a repository or a provider is shown as text, never as a link or markup.
 */
type ToolPart = Extract<AssistantMessage["parts"][number], { type: `tool-${string}` }>;
type ToolName = ToolPart["type"] extends `tool-${infer N}` ? N : never;
export type Out<N extends ToolName> = Exclude<
  Extract<ToolPart, { type: `tool-${N}`; state: "output-available" }>["output"],
  { error: string }
>;

export { ago };

const INTERNAL = /^\/(app|docs|runs|changes|scan|providers|packages|welcome|trust)(\/|\?|#|$)/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

/** A line on GitHub at the scanned commit, built from the repository, commit and path Teire read. */
const lineHref = (repo: string, sha: string | null | undefined, file: string, line: number) =>
  sha && SHA.test(sha) && REPO.test(repo)
    ? `https://github.com/${repo}/blob/${sha}/${file.split("/").map(encodeURIComponent).join("/")}#L${line}`
    : null;

/** A recorded source's page, shown by its host: only an https address Teire stored, never model text. */
function SourceHost({ url }: { url: string | null | undefined }) {
  if (!url?.startsWith("https://")) return null;
  let host: string;
  try {
    host = new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="entity-link inline-flex items-center gap-0.5"
    >
      {host}
      <ArrowUpRight className="size-3" aria-hidden />
    </a>
  );
}
const OURS = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/\d+$/;

/** A link inside Teire, or a Teire PR/issue on GitHub; anything else is text. */
export function SafeLink({
  href,
  children,
  className,
}: {
  href?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  if (href && INTERNAL.test(href))
    return (
      <Link href={href} className={cn("entity-link", className)}>
        {children}
      </Link>
    );
  if (href && OURS.test(href))
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn("entity-link inline-flex items-center gap-0.5", className)}
      >
        {children}
        <ArrowUpRight className="size-3" aria-hidden />
      </a>
    );
  return <span className={className}>{children}</span>;
}

function Card({
  eyebrow,
  asOf,
  link,
  linkLabel = "Open",
  tone,
  children,
}: {
  eyebrow: string;
  asOf?: string | null;
  link?: string | null;
  linkLabel?: string;
  tone?: "signal";
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "not-prose flex flex-col gap-2.5 rounded-lg bg-sheet p-3 ring-1 ring-rule ring-inset",
        tone === "signal" && "ring-signal/40",
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <span className={cn("eyebrow", tone === "signal" && "text-signal")}>{eyebrow}</span>
        {asOf ? (
          <time dateTime={asOf} title={asOf} className="font-mono text-[11px] text-ink-3">
            as of {ago(asOf)}
          </time>
        ) : null}
      </header>
      {children}
      {link ? (
        <SafeLink href={link} className="w-fit text-xs text-ink-2">
          {linkLabel} ›
        </SafeLink>
      ) : null}
    </section>
  );
}

// Each mode by its key and by its words (the tools say both).
const MODE: Record<string, { label: string; tone: Tone }> = Object.fromEntries(
  FIX_MODES.flatMap((m) => [
    [m.value, { label: m.label, tone: m.tone }],
    [m.label, { label: m.label, tone: m.tone }],
  ]),
);

function ModeChip({ mode }: { mode: string }) {
  const m = MODE[mode] ?? { label: mode, tone: "neutral" as Tone };
  return (
    <StatusChip tone={m.tone} glyph={false}>
      {m.label}
    </StatusChip>
  );
}

const proofOf = (steps: { key: string; state: string; detail?: string }[]) =>
  Object.fromEntries(steps.map((s) => [s.key, { state: s.state, detail: s.detail }])) as unknown as Proof;

type RunLite = Out<"list_runs">["runs"][number];

function RunLine({ run, why }: { run: RunLite; why?: string }) {
  const live = run.status === "running" || run.status === "stopping";
  return (
    <Link href={run.link} className="row-link flex flex-col gap-1 rounded-md py-1.5 pr-9 pl-2 hover:bg-hover">
      <span className="flex items-center gap-2">
        <MiniFlow proof={proofOf(run.proof)} subject={subjectMark(run.group ?? undefined)} size="xs" />
        <span className="min-w-0 truncate font-mono text-xs text-ink">{run.subject}</span>
        {live ? <LiveDot className="ml-auto" /> : null}
      </span>
      <span className="flex items-center gap-2 text-[11px] text-ink-3">
        <span className="truncate">{run.repo}</span>
        {run.evidence ? <EvidenceChip kind={run.evidence} /> : <span>{run.status}</span>}
      </span>
      {why ? <span className="text-xs text-ink-2">{why}</span> : null}
    </Link>
  );
}

type FigureTone = "attention" | "signal" | "proven" | "broke" | "neutral";

const FIGURE_TONE: Record<FigureTone, string> = {
  attention: "bg-attention-soft text-attention",
  signal: "bg-signal-soft text-signal",
  proven: "bg-proven-soft text-proven",
  broke: "bg-broke-soft text-broke",
  neutral: "bg-sunken text-ink-2",
};

/** Figures as the Overview's stat tiles read: an icon in its tone (grey at zero), the number, its name. */
function Figures({
  items,
}: {
  items: { label: string; value: number | string; icon: LucideIcon; tone: FigureTone; zero?: boolean }[];
}) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map(({ label, value, icon: Icon, tone, zero }) => (
        <li
          key={label}
          className="flex items-center gap-2 rounded-md bg-sunken/60 p-1.5 ring-1 ring-rule ring-inset"
        >
          <span
            aria-hidden
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md",
              FIGURE_TONE[zero ? "neutral" : tone],
            )}
          >
            <Icon className="size-3.5" strokeWidth={2} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="font-mono text-base leading-none text-ink tabular-nums">{value}</span>
            <span className="mt-0.5 truncate text-[11px] text-ink-3">{label}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function OverviewCard({ o }: { o: Out<"get_overview"> }) {
  return (
    <Card eyebrow={`Overview · ${o.account ?? ""}`} asOf={o.asOf} link={o.link}>
      <Figures
        items={[
          {
            label: "need you",
            value: o.counts.needsAPerson,
            icon: Hand,
            tone: "attention",
            zero: !o.counts.needsAPerson,
          },
          {
            label: "working",
            value: o.counts.goingOrWaiting,
            icon: Activity,
            tone: "signal",
            zero: !o.counts.goingOrWaiting,
          },
          {
            label: "PRs proven",
            value: `${o.counts.openPrsProven}/${o.counts.openPrs}`,
            icon: GitPullRequest,
            tone: "proven",
            zero: !o.counts.openPrsProven,
          },
          {
            label: "reaching code",
            value: o.counts.changesReachingCode,
            icon: Zap,
            tone: "broke",
            zero: !o.counts.changesReachingCode,
          },
        ]}
      />
      {o.needsAPerson.length ? (
        <div className="flex flex-col">
          {o.needsAPerson.slice(0, 4).map((r) => (
            <RunLine key={r.id} run={r} why={r.why} />
          ))}
        </div>
      ) : null}
      {o.deadlines.length ? (
        <ul className="flex flex-col gap-1">
          {o.deadlines.slice(0, 3).map((d) => (
            <li key={d.changeId} className="flex items-center gap-2 text-xs">
              <SafeLink href={d.link} className="min-w-0 truncate text-ink">
                {d.title}
              </SafeLink>
              <span
                className={cn(
                  "ml-auto shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[11px]",
                  // Past: the model is gone and the code still names it.
                  d.deadline && Date.parse(d.deadline) < Date.now()
                    ? "bg-broke-soft text-broke"
                    : "bg-attention-soft text-attention",
                )}
              >
                {until(d.deadline)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function FindCard({ o }: { o: Out<"find"> }) {
  const empty = !o.findings.length && !o.runs.length && !o.prs.length;
  return (
    <Card eyebrow={`Found · ${o.query}`} asOf={o.asOf}>
      {empty ? <p className="text-sm text-ink-3">Nothing in Teire matches.</p> : null}
      {o.findings.length ? (
        // Each finding by its change's mark, where it is, and its verdict (V7 final review).
        <ul className="flex flex-col">
          {o.findings.slice(0, 4).map((f) => (
            <li key={`${f.repo}:${f.key}`}>
              <SafeLink
                href={f.link}
                className="row-link flex items-center gap-2 rounded-md py-1 pr-9 pl-1.5 text-xs hover:bg-hover"
              >
                <Mark brand={subjectMark(f.key)} size="sm" />
                <span className="min-w-0 flex-1 truncate text-ink">
                  {subjectOfKey(f.key).name}
                  {subjectOfKey(f.key).meta ? (
                    <span className="ml-1.5 font-mono text-[11px] text-ink-3">
                      {subjectOfKey(f.key).meta}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink-3">{f.repo.split("/")[1]}</span>
                <VerdictChip verdict={f.verdict} />
              </SafeLink>
            </li>
          ))}
        </ul>
      ) : null}
      {o.runs.length ? (
        <div className="flex flex-col">
          {o.runs.slice(0, 4).map((r) => (
            <RunLine key={r.id} run={r} />
          ))}
        </div>
      ) : null}
      {o.prs.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {o.prs.map((p) => (
            <li key={`${p.repo}:${p.number}`}>
              <SafeLink
                href={p.url}
                className={cn(
                  "flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] ring-1 ring-inset",
                  p.kind === "issue"
                    ? "bg-broke-soft text-broke ring-broke/20"
                    : p.draft
                      ? "bg-attention-soft text-attention ring-attention/20"
                      : "bg-proven-soft text-proven ring-proven/20",
                )}
              >
                <GitPullRequest className="size-3" aria-hidden />
                {p.repo.split("/")[1]} #{p.number}
                {p.state !== "open" ? ` · ${p.state}` : ""}
              </SafeLink>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function ReposCard({ o }: { o: Out<"list_repos"> }) {
  return (
    <Card eyebrow={`${o.total} repositor${o.total === 1 ? "y" : "ies"}`} asOf={o.asOf} link={o.link}>
      {o.repos.length ? (
        <ul className="flex flex-col">
          {o.repos.slice(0, 8).map((r) => (
            <li key={r.fullName}>
              <Link
                href={r.link}
                className="row-link flex items-center gap-2 rounded-md py-1.5 pr-9 pl-2 hover:bg-hover"
              >
                {r.live ? <LiveDot /> : <span className="size-2" />}
                <span className="min-w-0 truncate text-sm text-ink">{r.fullName}</span>
                <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-ink-3">
                  <span title="changes reaching the code" className="flex items-center gap-0.5">
                    <Zap className="size-3" aria-hidden />
                    {r.reaching}
                  </span>
                  <span title="open PRs" className="flex items-center gap-0.5">
                    <GitPullRequest className="size-3" aria-hidden />
                    {r.openPrs}
                  </span>
                  <ModeChip mode={r.fixMode} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-3">None right now.</p>
      )}
    </Card>
  );
}

export function RepoCard({ o }: { o: Out<"get_repo"> }) {
  return (
    <Card eyebrow="Repository" asOf={o.asOf} link={o.link}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{o.fullName}</span>
        {o.isPrivate ? (
          <StatusChip tone="neutral" glyph={false}>
            private
          </StatusChip>
        ) : null}
        <ModeChip mode={o.fixMode.mode} />
        <span className="font-mono text-[11px] text-ink-3">{o.fixMode.file ?? o.fixMode.origin}</span>
      </div>
      {o.lastScan?.status === "failed" ? (
        <p className="text-xs text-broke">Last scan failed: {o.lastScan.error}</p>
      ) : null}
      <Figures
        items={[
          { label: "reaching code", value: o.reaching, icon: Zap, tone: "broke", zero: !o.reaching },
          { label: "need you", value: o.needsPerson, icon: Hand, tone: "attention", zero: !o.needsPerson },
          {
            label: "open PRs",
            value: o.prs.length,
            icon: GitPullRequest,
            tone: "proven",
            zero: !o.prs.length,
          },
          { label: "recent runs", value: o.runs.length, icon: Play, tone: "neutral" },
        ]}
      />
      {o.top.length ? (
        <ul className="flex flex-col">
          {o.top.map((g) => (
            <GroupRow key={g.key} g={g} />
          ))}
        </ul>
      ) : null}
      {o.runs.length ? (
        <div className="flex flex-col">
          {o.runs.slice(0, 3).map((r) => (
            <RunLine key={r.id} run={r} />
          ))}
        </div>
      ) : null}
    </Card>
  );
}

const VERDICT: Record<string, { label: string; tone: Tone }> = {
  affected: { label: "Reaches your code", tone: "broke" },
  needs_human: { label: "Needs a person", tone: "attention" },
  check_by_hand: { label: "Check by hand", tone: "attention" },
  inconclusive: { label: "Sandbox decides", tone: "neutral" },
  not_affected: { label: "Doesn't reach it", tone: "proven" },
  not_applicable: { label: "Not your version", tone: "neutral" },
};

function VerdictChip({ verdict }: { verdict: string }) {
  const v = VERDICT[verdict] ?? { label: verdict, tone: "neutral" as Tone };
  return <StatusChip tone={v.tone}>{v.label}</StatusChip>;
}

/** Counts as tone pills (red reaching, amber needs you, green checked): the header of a findings list. */
function CountPills({ items }: { items: [number, string, FigureTone][] }) {
  return (
    <p className="flex flex-wrap gap-1.5">
      {items.map(([n, label, tone]) => (
        <span
          key={label}
          className={cn("rounded-full px-2 py-0.5 font-mono text-[11px]", FIGURE_TONE[n ? tone : "neutral"])}
        >
          {n} {label}
        </span>
      ))}
    </p>
  );
}

/**
 * One finding group in a list: its change's mark, its title, then only what sets it apart (the
 * lines it reaches, or a verdict other than "reaches your code", which the header already counts).
 */
function GroupRow({
  g,
}: {
  g: {
    key: string;
    title: string;
    verdict: string;
    sites: number;
    link: string;
    firstSite?: { file: string; line: number } | null;
  };
}) {
  return (
    <li>
      <SafeLink
        href={g.link}
        className="row-link flex items-center gap-2 rounded-md py-1 pr-9 pl-1.5 text-xs hover:bg-hover"
      >
        <Mark brand={subjectMark(g.key)} size="sm" />
        <span className="min-w-0 flex-1 truncate text-ink">{g.title}</span>
        {g.firstSite ? (
          <span className="hidden max-w-40 shrink truncate font-mono text-[11px] text-ink-3 sm:inline">
            {g.firstSite.file.split("/").at(-1)}:{g.firstSite.line}
          </span>
        ) : null}
        {g.verdict !== "affected" ? (
          <VerdictChip verdict={g.verdict} />
        ) : g.sites ? (
          <span className="shrink-0 font-mono text-[11px] text-ink-3">
            {g.sites} line{g.sites === 1 ? "" : "s"}
          </span>
        ) : null}
      </SafeLink>
    </li>
  );
}

export function FindingsCard({ o }: { o: Out<"list_findings"> }) {
  return (
    <Card eyebrow={`Findings · ${o.repo}`} asOf={o.asOf} link={o.link}>
      <CountPills
        items={[
          [o.counts.reaching, "reaching", "broke"],
          [o.counts.needsPerson, "need you", "attention"],
          [o.counts.notReaching, "checked, clear", "proven"],
        ]}
      />
      <ul className="flex flex-col">
        {o.groups.slice(0, 8).map((g) => (
          <GroupRow key={g.key} g={g} />
        ))}
      </ul>
    </Card>
  );
}

/** Before a finding's first run: change → your code → fix → PR, each in what happens next. */
function findingGraph(o: Out<"get_finding">): FlowGraph {
  const subject = subjectOfKey(o.key);
  const sites = o.sites.length + o.moreSites;
  const human = o.verdict === "needs_human" || o.verdict === "check_by_hand";
  const fix: FlowTile = o.key.startsWith("runtime/")
    ? { id: "fix", entity: "fix", state: "skipped", label: "By hand" }
    : human
      ? { id: "fix", entity: "fix", state: "skipped", label: "A person decides" }
      : { id: "fix", entity: "fix", state: "pending", label: "Fix" };
  return {
    tiles: [
      {
        id: "change",
        entity: "change",
        state: "done",
        label: subject.name,
        ...(subject.meta ? { meta: subject.meta } : {}),
        ...(o.deadline ? { caption: until(o.deadline) } : {}),
        brand: subjectMark(o.key),
      },
      {
        id: "code",
        entity: "code",
        state: human ? "not_proven" : "done",
        label: "Your code",
        meta: sites ? `${sites} call site${sites === 1 ? "" : "s"}` : "installed version",
      },
      fix,
      {
        id: "out",
        entity: "outcome",
        state: fix.state === "skipped" ? "skipped" : "pending",
        label: "Pull request",
      },
    ],
    links: [
      { from: "change", to: "code", state: "done" },
      { from: "code", to: "fix", state: fix.state === "skipped" ? "skipped" : "pending" },
      { from: "fix", to: "out", state: fix.state === "skipped" ? "skipped" : "pending" },
    ],
  };
}

export function FindingCard({ o }: { o: Out<"get_finding"> }) {
  return (
    <Card eyebrow={`Finding · ${o.repo}`} asOf={o.change?.checkedAt ?? o.asOf} link={o.link}>
      <div className="flex items-center gap-2">
        <Mark brand={subjectMark(o.key)} size="sm" />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{o.title}</span>
        <VerdictChip verdict={o.verdict} />
      </div>
      {/* Its newest run as the trail its page draws; before any run, what happens next. */}
      <Trail
        graph={o.flow ?? findingGraph(o)}
        runHref={o.run?.link}
        omit={["repository"]}
        label={`${o.title} on ${o.repo}`}
      />
      {o.change?.replacement ? <Swap from={subjectOfKey(o.key).name} to={o.change.replacement} /> : null}
      {o.sites.length ? (
        <ul className="flex flex-col gap-1 text-xs" aria-label="The lines it reaches">
          {o.sites.slice(0, 3).map((x) => {
            const href = lineHref(o.repo, o.sha, x.file, x.line);
            return (
              <li
                key={`${x.file}:${x.line}`}
                className="rounded-md bg-sunken px-2 py-1 ring-1 ring-rule ring-inset"
              >
                <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer noopener" className="entity-link truncate">
                      {x.file}:{x.line}
                    </a>
                  ) : (
                    <span className="truncate">
                      {x.file}:{x.line}
                    </span>
                  )}
                  <span className="ml-auto shrink-0">{x.resolution}</span>
                </span>
                <pre className="overflow-x-auto font-mono text-[11px] text-ink">{x.code}</pre>
              </li>
            );
          })}
          {o.sites.length + o.moreSites > 3 ? (
            <li className="font-mono text-[11px] text-ink-3">
              +{o.sites.length + o.moreSites - 3} more on <SafeLink href={o.link}>the finding</SafeLink>
            </li>
          ) : null}
        </ul>
      ) : null}
      {o.change?.quote ? (
        <OwnWords
          quote={o.change.quote}
          link={o.change.link}
          source={o.change.sourceUrl}
          basis={o.change.trustBasis}
        />
      ) : null}
    </Card>
  );
}

export function RunsCard({ o }: { o: Out<"list_runs"> }) {
  return (
    <Card eyebrow={`Runs · ${o.which.replace("_", " ")}`} asOf={o.asOf} link={o.link}>
      {o.runs.length ? (
        <div className="flex flex-col">
          {o.runs.map((r) => (
            <RunLine key={r.id} run={r} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-ink-3">No runs match.</p>
      )}
    </Card>
  );
}

const ms = (n: number | null) =>
  n === null ? "–" : n < 60_000 ? `${Math.round(n / 1000)} s` : `${Math.round(n / 60_000)} min`;

export function RunCard({ o }: { o: Out<"get_run"> | Out<"explain_run"> }) {
  const explained = "steps" in o ? o : null;
  return (
    <Card eyebrow={`Run · ${o.repo}`} asOf={o.asOf} link={o.link} linkLabel="Open the proof sheet">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-ink">{o.subject}</span>
        <EvidenceChip kind={o.evidence} />
      </div>
      {/* The run as its breadcrumb trail (plan revision 3.4, V6): the same flow its page draws. */}
      {"flow" in o && o.flow ? (
        <Trail graph={o.flow} runHref={o.link} omit={["repository"]} label={`The run on ${o.repo}`} />
      ) : "proof" in o && Array.isArray(o.proof) && o.proof.length ? (
        <MiniFlow proof={proofOf(o.proof)} />
      ) : null}
      {explained?.meaning ? <p className="text-xs text-ink-2">{explained.meaning}</p> : null}
      <p className="flex flex-wrap gap-1.5 font-mono text-[11px] text-ink-2">
        {[
          o.status,
          o.durationMs !== null ? ms(o.durationMs) : null,
          `$${o.costUsd.toFixed(3)}`,
          `${o.modelCalls} calls`,
        ]
          .filter((x) => x !== null)
          .map((x) => (
            <span key={x} className="rounded-full bg-sunken px-2 py-0.5">
              {x}
            </span>
          ))}
      </p>
      {o.ledger.length ? (
        // Each check before → after, as the run page's ledger reads; red where it broke.
        <ul className="flex flex-col gap-1">
          {o.ledger.map((c) => {
            const side = (x: (typeof c)["before"]) =>
              x
                ? x.total !== null
                  ? `${x.passed}/${x.total}`
                  : x.exit === 0
                    ? "pass"
                    : `exit ${x.exit}`
                : "–";
            const broke = c.before?.exit === 0 && c.after && c.after.exit !== 0;
            return (
              <li key={c.check} className="flex items-center gap-1.5 font-mono text-[11px]">
                <span className="min-w-0 flex-1 truncate text-ink-2">{c.check}</span>
                <span className="rounded bg-sunken px-1.5 py-0.5 text-ink-3">{side(c.before)}</span>
                <span aria-hidden className="text-ink-3">
                  →
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5",
                    broke
                      ? "bg-broke-soft text-broke"
                      : c.after?.exit === 0
                        ? "bg-proven-soft text-proven"
                        : "bg-sunken text-ink-2",
                  )}
                >
                  {side(c.after)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {o.notCovered.length ? (
        <div className="flex flex-col gap-0.5">
          <span className="eyebrow">Not covered</span>
          {o.notCovered.map((r) => (
            <span key={r} className="text-xs text-ink-2">
              {r}
            </span>
          ))}
        </div>
      ) : null}
      {o.pr ? (
        <SafeLink href={o.pr.url} className="w-fit text-xs text-ink">
          {o.pr.kind === "issue" ? "Issue" : "PR"} #{o.pr.number} · {o.pr.state}
        </SafeLink>
      ) : null}
      {explained?.steps.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-2">
            What Teire did ({explained.steps.length} steps)
          </summary>
          <ol className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-ink-3">
            {explained.steps.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps can repeat a label.
              <li key={i}>
                <span className="text-ink-2">{s.label}</span> · {s.outcome}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </Card>
  );
}

export function ChangesCard({ o }: { o: Out<"list_changes"> }) {
  return (
    <Card eyebrow={`Catalog · ${o.total} change${o.total === 1 ? "" : "s"}`} asOf={o.asOf} link={o.link}>
      <ul className="flex flex-col">
        {o.changes.slice(0, 8).map((c) => {
          const brand = changeBrand(c);
          return (
            <li key={c.id}>
              <SafeLink
                href={c.link}
                className="row-link flex items-center gap-2 rounded-md py-1 pr-9 pl-1.5 text-xs hover:bg-hover"
              >
                {brand ? <Mark brand={brand} size="sm" /> : null}
                <span className="min-w-0 flex-1 truncate text-ink">{c.title}</span>
                {c.deadline ? (
                  <span className="shrink-0 rounded-full bg-attention-soft px-1.5 py-0.5 font-mono text-[11px] text-attention">
                    {until(c.deadline)}
                  </span>
                ) : null}
              </SafeLink>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

type Reach = Out<"affected_by_change">["reaches"][number];

/** Old → new as two chips, struck through and green, as Config's before → after reads. */
function Swap({ from, to }: { from: string; to: string }) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[11px]">
      <span className="truncate rounded bg-broke-soft px-1.5 py-0.5 text-broke line-through decoration-broke/50">
        {from}
      </span>
      <span aria-hidden className="text-ink-3">
        →
      </span>
      <span className="truncate rounded bg-proven-soft px-1.5 py-0.5 text-proven">{to}</span>
    </p>
  );
}

/** A source's own words, open (revamp S2): the quote, the page it came from, and the change record. */
function OwnWords({
  quote,
  link,
  source,
  basis,
}: {
  quote: string;
  link?: string | null;
  source?: string | null;
  basis?: string | null;
}) {
  return (
    <figure className="flex flex-col gap-1 text-xs">
      <blockquote className="line-clamp-4 border-l-2 border-signal/60 pl-2 break-words text-ink-2">
        {quote}
      </blockquote>
      <figcaption className="flex flex-wrap items-center gap-x-1.5 font-mono text-[11px] text-ink-3">
        <SourceHost url={source} />
        {basis ? <span>{basis.replace(/[_-]/g, " ")}</span> : null}
        {link ? <SafeLink href={link}>change record</SafeLink> : null}
      </figcaption>
    </figure>
  );
}

export function ChangeCard({ o }: { o: Out<"get_change"> }) {
  const brand = changeBrand(o);
  const to = o.replacement ?? o.to;
  return (
    <Card eyebrow="Change" asOf={o.asOf} link={o.link} linkLabel="Open the change">
      <div className="flex items-center gap-2">
        {brand ? <Mark brand={brand} size="sm" /> : null}
        <span className="min-w-0 flex-1 font-medium text-ink">{o.title}</span>
        {o.deadline ? <StatusChip tone="attention">{until(o.deadline)}</StatusChip> : null}
      </div>
      {to ? <Swap from={o.from ?? o.subject} to={to} /> : null}
      {o.reaches.length ? (
        <ReachFan reaches={o.reaches} />
      ) : (
        <p className="text-xs text-ink-3">It doesn&apos;t reach any of your repositories.</p>
      )}
      {o.quote ? <OwnWords quote={o.quote} source={o.sourceUrl} basis={o.trustBasis} /> : null}
      {fixInAll(o.id, o.reaches) ? (
        <SafeLink href={fixInAll(o.id, o.reaches)} className="w-fit text-xs text-ink-2">
          Fix in all ›
        </SafeLink>
      ) : null}
    </Card>
  );
}

/** Fix in all lives on Changes for you, with its per-repository preview and Confirm (rule 11). */
const fixInAll = (changeId: string, reaches: Reach[]) =>
  reaches.some((r) => r.plan.kind === "run") ? `/app/changes?change=${encodeURIComponent(changeId)}` : null;

export function ReachCard({ o }: { o: Out<"affected_by_change"> }) {
  const all = fixInAll(o.changeId, o.reaches);
  return (
    <Card
      eyebrow={`Reaches ${o.reaches.length} repositor${o.reaches.length === 1 ? "y" : "ies"}`}
      asOf={o.asOf}
      link={all ?? o.link}
      linkLabel={all ? "Fix in all" : "Open"}
    >
      {o.title ? <span className="font-medium text-ink">{o.title}</span> : null}
      {o.reaches.length ? (
        <ReachFan reaches={o.reaches} />
      ) : (
        <p className="text-xs text-ink-3">None of your repositories.</p>
      )}
    </Card>
  );
}

const show = (v: unknown) =>
  Array.isArray(v)
    ? v.length
      ? v.join(", ")
      : "none"
    : v === undefined || v === null
      ? "default"
      : String(v);

export function ConfigCard({ o }: { o: Out<"get_config"> }) {
  return (
    <Card eyebrow={`teire.yml · ${o.repo}`} asOf={o.asOf} link={o.link}>
      <p className="font-mono text-[11px] text-ink-3">from {o.source}</p>
      {/* Cells as the Config tab's board draws them: what is set reads dark, what is off or empty grey. */}
      <dl className="grid grid-cols-2 gap-1.5">
        {Object.entries(o.values).map(([k, v]) => {
          const said = show(v);
          const quiet = said === "none" || said === "false";
          return (
            <div
              key={k}
              className="flex min-w-0 flex-col rounded-md bg-sunken/60 px-2 py-1 ring-1 ring-rule ring-inset"
            >
              <dt className="truncate text-[11px] text-ink-3">{k}</dt>
              <dd className={cn("truncate font-mono text-[11px]", quiet ? "text-ink-3" : "text-ink")}>
                {said}
              </dd>
            </div>
          );
        })}
      </dl>
    </Card>
  );
}

export function ConfigSnippet({ o }: { o: Out<"preview_config"> }) {
  return (
    <Card eyebrow={`Preview · ${o.file}`} asOf={o.asOf} link={o.link} linkLabel="Open the Config tab">
      <pre className="overflow-x-auto rounded-md bg-sunken p-2 font-mono text-[11px] ring-1 ring-rule ring-inset">
        {o.removed.map((l) => (
          <span key={`-${l}`} className="block text-broke">
            - {l}
          </span>
        ))}
        {o.added.map((l) => (
          <span key={`+${l}`} className="block text-proven">
            + {l}
          </span>
        ))}
        {o.unchanged ? <span className="block text-ink-3">(already set)</span> : null}
      </pre>
      <ul className="flex flex-col gap-0.5">
        {o.effects.map((e) => (
          <li key={e} className="text-xs text-ink-2">
            {e}
          </li>
        ))}
      </ul>
    </Card>
  );
}

const PURPOSE_COLOR = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function UsageCard({ o }: { o: Out<"get_usage"> }) {
  const share = Math.min(100, (o.assistant.todayUsd / o.assistant.dailyCapUsd) * 100);
  const model = o.byPurpose.reduce((n, p) => n + p.costUsd, 0);
  const parts = o.byPurpose.filter((p) => p.costUsd > 0).slice(0, PURPOSE_COLOR.length);
  return (
    <Card eyebrow="Usage · 30 days" asOf={o.asOf} link={o.link}>
      <Figures
        items={[
          { label: "runs", value: o.runs, icon: Play, tone: "neutral" },
          { label: "sandbox min", value: o.sandboxMinutes, icon: Box, tone: "neutral" },
          { label: "models", value: `$${model.toFixed(2)}`, icon: Cpu, tone: "signal", zero: !model },
          {
            label: "Ask Teire",
            value: `$${o.assistant.monthUsd.toFixed(2)}`,
            icon: MessageCircleQuestion,
            tone: "signal",
            zero: !o.assistant.monthUsd,
          },
        ]}
      />
      {parts.length ? (
        // Where the model money went, as one bar in the Usage chart's colours.
        <figure className="flex flex-col gap-1.5">
          <span className="flex h-2 overflow-hidden rounded-full bg-sunken">
            {parts.map((p, i) => (
              <span
                key={p.purpose}
                style={{ width: `${(p.costUsd / model) * 100}%`, background: PURPOSE_COLOR[i] }}
                title={`${p.purpose}: $${p.costUsd.toFixed(3)} · ${p.calls} calls`}
              />
            ))}
          </span>
          <figcaption className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink-3">
            {parts.map((p, i) => (
              <span key={p.purpose} className="flex items-center gap-1">
                <span aria-hidden className="size-2 rounded-full" style={{ background: PURPOSE_COLOR[i] }} />
                {p.purpose} ${p.costUsd.toFixed(2)}
              </span>
            ))}
          </figcaption>
        </figure>
      ) : null}
      <div className="flex flex-col gap-1">
        <span className="flex justify-between text-[11px] text-ink-3">
          <span>Ask Teire today</span>
          <span className="font-mono">
            ${o.assistant.todayUsd.toFixed(3)} / ${o.assistant.dailyCapUsd.toFixed(2)}
          </span>
        </span>
        <span className="h-1.5 overflow-hidden rounded-full bg-sunken ring-1 ring-rule ring-inset">
          <span className="block h-full bg-signal" style={{ width: `${share}%` }} />
        </span>
      </div>
    </Card>
  );
}

export function DocsCard({ o }: { o: Out<"search_docs"> }) {
  return (
    <Card eyebrow="From the docs">
      <ul className="flex flex-col gap-1.5">
        {o.results.slice(0, 4).map((r) => (
          <li key={r.url} className="flex flex-col">
            <SafeLink href={r.url} className="text-sm text-ink">
              {r.title}
            </SafeLink>
            {r.snippet && r.snippet !== r.title ? (
              <span className="line-clamp-2 text-[11px] text-ink-3">{r.snippet}</span>
            ) : null}
          </li>
        ))}
        {!o.results.length ? <li className="text-sm text-ink-3">Nothing in the docs matches.</li> : null}
      </ul>
    </Card>
  );
}

/** Each gate as a step of a trail: passed green, the one that holds it red, a note quiet (B13). */
const GATE_ENTITY: Record<string, FlowEntity> = {
  repository: "repository",
  verdict: "code",
  ignore: "check",
  "fix mode": "fix",
  settings: "check",
  "open PR": "outcome",
  PR: "outcome",
  "last run": "sandbox",
  "PR limit": "outcome",
  budget: "fix",
};

export function WhyCard({ o }: { o: Out<"why_no_pr"> }) {
  const graph: FlowGraph = {
    tiles: o.gates.map((g, i) => ({
      id: `g${i}`,
      entity: GATE_ENTITY[g.gate] ?? "check",
      state: g.state === "holds" ? "failed" : g.state === "ok" ? "proven" : "done",
      label: g.gate,
      caption: g.said,
      ...(g.href ? { href: g.href } : {}),
    })),
    links: [],
  };
  graph.links = graph.tiles.slice(1).map((t, i) => ({ from: `g${i}`, to: t.id, state: t.state }));
  return (
    <Card eyebrow={`Why no PR · ${o.repo}`} asOf={o.asOf} link={o.link}>
      <p className="text-sm font-medium text-ink">{o.answer}</p>
      <Trail graph={graph} label="Teire's gates, in order" />
    </Card>
  );
}

export function StepsCard({ o }: { o: Out<"show_steps"> }) {
  return (
    <Card eyebrow="How to">
      <span className="font-medium text-ink">{o.title}</span>
      {/* A how-to is a flow of numbered steps joined by a rail, each one line. */}
      <ol className="relative flex flex-col gap-2">
        <span aria-hidden className="absolute top-3 bottom-3 left-[11px] w-px bg-rule-strong" />
        {o.steps.map((s, i) => (
          <li key={s.text} className="relative flex items-start gap-3 text-sm">
            <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-lg bg-sheet font-mono text-[11px] text-ink shadow-tile ring-1 ring-ink/40">
              {i + 1}
            </span>
            <span className="pt-0.5 text-ink-2">
              {s.text}
              {s.href ? (
                <>
                  {" "}
                  <SafeLink href={s.href}>Open ›</SafeLink>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function ChoicesCard({
  o,
  onPick,
  disabled,
}: {
  o: Out<"offer_choices">;
  onPick: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="not-prose flex flex-col gap-2">
      <span className="text-sm text-ink">{o.question}</span>
      <span className="flex flex-wrap gap-1.5">
        {o.options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onPick(opt.value)}
            className="rounded-full bg-sheet px-3 py-1 text-xs text-ink ring-1 ring-rule-strong ring-inset hover:bg-hover disabled:opacity-50"
          >
            {opt.label}
          </button>
        ))}
      </span>
    </div>
  );
}

export function NoticeCard({ notice }: { notice: AssistantNotice }) {
  return (
    <Card eyebrow={notice.kind === "budget" ? "Budget reached" : "Nemotron didn't answer"}>
      <p className="text-sm text-ink">{notice.message}</p>
      {notice.results?.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-ink-3">Search results from the docs (not an answer):</span>
          {notice.results.map((r) => (
            <SafeLink key={r.url} href={r.url} className="w-fit text-xs">
              {r.title}
            </SafeLink>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

interface ActionRow {
  id: string;
  status: string;
  result: string | null;
  links: { label: string; href: string }[];
}

type Proposed = Out<"propose_action">;

/** What each action sets going after Confirm, as the tiles the rest of Teire draws for it. */
const ACTION_STEPS: Record<string, [FlowEntity, string][]> = {
  "set-fix-mode": [["update", "Fix mode"]],
  "set-installation-fix-mode": [["update", "Every repo's mode"]],
  rescan: [
    ["review", "Scan"],
    ["check", "Findings"],
  ],
  fix: [
    ["fix", "Fix"],
    ["sandbox", "Your checks"],
    ["outcome", "Pull request"],
  ],
  pause: [["update", "Paused"]],
  resume: [["update", "Resumed"]],
  ignore: [["update", "Ignored"]],
  unignore: [["update", "Watched again"]],
  refresh: [
    ["fix", "Refresh"],
    ["outcome", "Pull request"],
  ],
  rebase: [
    ["fix", "Rebase"],
    ["outcome", "Pull request"],
  ],
  recreate: [
    ["fix", "Recreate"],
    ["outcome", "Pull request"],
  ],
  "cancel-run": [["fix", "Run stops"]],
  "retry-run": [
    ["fix", "Run again"],
    ["sandbox", "Your checks"],
    ["outcome", "Pull request"],
  ],
  "reverify-run": [
    ["sandbox", "Re-verify"],
    ["check", "Your checks"],
  ],
  "open-draft-anyway": [["outcome", "Draft PR"]],
  "config-pr": [
    ["update", "teire.yml"],
    ["outcome", "Pull request"],
  ],
  "starter-config-pr": [
    ["update", "teire.yml"],
    ["outcome", "Pull request"],
  ],
  "fix-in-all": [
    ["fix", "A run each"],
    ["outcome", "A PR each"],
  ],
};

/**
 * The action as a trail: where it acts, then what it sets going. Before Confirm the steps are
 * dashed; while the worker takes it the first one pulses; then it reads what the worker said.
 */
function actionGraph(kind: string, where: string, status: string | null): FlowGraph {
  const steps = ACTION_STEPS[kind] ?? [["update", "Done"]];
  const terminal = status ? TERMINAL.has(status as ActionStatus) : false;
  const first: FlowState = !status ? "pending" : !terminal ? "live" : status === "done" ? "done" : "failed";
  const tiles: FlowTile[] = [
    { id: "where", entity: "repository", state: "done", label: where.split("/").pop() ?? where },
    ...steps.map(([entity, label], i) => ({
      id: `s${i}`,
      entity,
      state: i === 0 ? first : ("pending" as FlowState),
      label,
    })),
  ];
  return {
    tiles,
    links: tiles.slice(1).map((t, i) => ({ from: tiles[i]?.id as string, to: t.id, state: t.state })),
  };
}

/**
 * The only way Ask Teire changes anything (D119): the exact action, its scope, Confirm and Cancel.
 * Confirm posts the server-signed proposal; the card then follows the action to the worker's word.
 */
export function ActionCard({ o }: { o: Proposed }) {
  const [state, setState] = useState<"idle" | "sending" | "cancelled">("idle");
  const [action, setAction] = useState<ActionRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposal = "proposal" in o ? o : "alternative" in o ? o.alternative : null;
  const proposalId = proposal && "id" in proposal ? String(proposal.id) : null;

  // A card seen again (a reload, another tab) shows the action it already started, not Confirm.
  useEffect(() => {
    if (!proposalId) return;
    let alive = true;
    fetch(`/api/assistant/confirm?id=${encodeURIComponent(proposalId)}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { action: ActionRow | null }).action : null))
      .then((a) => {
        if (alive && a) setAction((current) => current ?? a);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [proposalId]);

  // Followed every second, every three after a minute; after ten the card hands over to Activity.
  const [since] = useState(() => Date.now());
  const tooLong =
    !!action && !TERMINAL.has(action.status as ActionStatus) && Date.now() - since > 10 * 60_000;
  useEffect(() => {
    if (!action || TERMINAL.has(action.status as ActionStatus) || Date.now() - since > 10 * 60_000) return;
    let alive = true;
    const t = setTimeout(
      async () => {
        const res = await fetch(`/api/actions/${action.id}`, { cache: "no-store" }).catch(() => null);
        if (alive && res?.ok) setAction((await res.json()) as ActionRow);
        else if (alive) setAction({ ...action });
      },
      Date.now() - since > 60_000 ? 3000 : 1000,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [action, since]);

  const confirm = async () => {
    if (!proposal || !("proposal" in proposal)) return;
    setState("sending");
    setError(null);
    const res = await fetch("/api/assistant/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposal: proposal.proposal }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as {
      ok: boolean;
      action?: ActionRow;
      error?: string;
    } | null;
    if (body?.ok && body.action) setAction(body.action);
    else setError(body?.error ?? "Teire couldn't be reached");
    setState("idle");
  };

  const refused = "refused" in o ? o.refused : null;
  const terminal = action && TERMINAL.has(action.status as ActionStatus);
  return (
    <Card
      eyebrow={action ? "Action" : proposal ? "Proposed action" : "Not something Teire does"}
      tone="signal"
    >
      {refused ? <p className="text-sm text-ink-2">{refused}</p> : null}
      {"github" in o && typeof o.github === "string" ? (
        <SafeLink href={o.github} className="w-fit text-xs">
          Open it on GitHub
        </SafeLink>
      ) : null}
      {proposal ? (
        <>
          <p className="text-sm font-medium text-ink">{proposal.effect}</p>
          {"kind" in proposal && typeof proposal.kind === "string" ? (
            <Trail
              graph={actionGraph(
                proposal.kind,
                "repo" in proposal && typeof proposal.repo === "string" ? proposal.repo : "Teire",
                action?.status ?? null,
              )}
              label={proposal.effect}
            />
          ) : null}
          {"details" in proposal && Array.isArray(proposal.details) && proposal.details.length ? (
            <ul className="flex flex-col gap-0.5 font-mono text-[11px] text-ink-2">
              {(proposal.details as string[]).map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
          {"means" in proposal && proposal.means ? (
            <p className="text-xs text-ink-2">{String(proposal.means)}</p>
          ) : null}
          {"why" in proposal && proposal.why && !("means" in proposal && proposal.means) ? (
            <p className="text-xs text-ink-2">{proposal.why}</p>
          ) : null}
          {"note" in proposal && proposal.note ? (
            <p className="font-mono text-[11px] text-ink-3">{proposal.note}</p>
          ) : null}
          {action ? (
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-2 text-xs">
                {!terminal ? (
                  <Loader2 className="size-3.5 animate-spin text-signal" aria-hidden />
                ) : action.status === "done" ? (
                  <Check className="size-3.5 text-proven" aria-hidden />
                ) : (
                  <X className="size-3.5 text-broke" aria-hidden />
                )}
                <span className="text-ink">
                  {action.status === "refused" ? "Refused: " : action.status === "failed" ? "Failed: " : ""}
                  {action.result ?? (terminal ? action.status : `${action.status}…`)}
                </span>
              </span>
              {tooLong ? (
                <span className="text-xs text-ink-3">
                  Still going; its outcome shows in the repository's Activity.
                </span>
              ) : null}
              {action.links.map((l) => (
                <SafeLink key={l.href} href={l.href} className="w-fit text-xs">
                  {l.label} ›
                </SafeLink>
              ))}
            </div>
          ) : state === "cancelled" ? (
            <p className="text-xs text-ink-3">Cancelled. Nothing was changed.</p>
          ) : (
            <span className="flex items-center gap-2">
              <Button size="sm" onClick={confirm} disabled={state === "sending"}>
                {state === "sending" ? "Confirming…" : "Confirm"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setState("cancelled")}
                disabled={state === "sending"}
              >
                Cancel
              </Button>
            </span>
          )}
          {error ? <p className="text-xs text-broke">{error}</p> : null}
        </>
      ) : null}
    </Card>
  );
}
