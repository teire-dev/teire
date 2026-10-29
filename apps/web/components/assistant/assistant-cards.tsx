"use client";

import type { ActionStatus } from "@teire/engine/actions";
import { TERMINAL } from "@teire/engine/actions";
import { ArrowUpRight, Check, CircleAlert, Info, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { LiveDot } from "@/components/teire/live-dot";
import { ProofGlyphs } from "@/components/teire/proof-glyphs";
import { EvidenceChip, StatusChip, type Tone } from "@/components/teire/status-chip";
import { Button } from "@/components/ui/button";
import type { AssistantMessage, AssistantNotice } from "@/lib/assistant/message";
import type { Proof } from "@/lib/proof";
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

const INTERNAL = /^\/(app|docs|runs|changes|scan|providers|packages|welcome|trust)(\/|\?|#|$)/;
const OURS = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/\d+$/;

export function ago(iso: string | null | undefined) {
  if (!iso) return null;
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

function until(iso: string | null | undefined) {
  if (!iso) return null;
  const d = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
  return d > 1 ? `in ${d} days` : d === 1 ? "tomorrow" : d === 0 ? "today" : `${-d} days ago`;
}

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
          <time dateTime={asOf} title={asOf} className="font-mono text-[10px] text-ink-3">
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

const MODE: Record<string, { label: string; tone: Tone }> = {
  auto: { label: "Automatic", tone: "proven" },
  ask: { label: "Ask first", tone: "attention" },
  off: { label: "Off", tone: "neutral" },
};

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
    <Link href={run.link} className="row-link flex flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-hover">
      <span className="flex items-center gap-2">
        <ProofGlyphs proof={proofOf(run.proof)} />
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

function Figures({ items }: { items: [string, number | string][] }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-md bg-sunken px-2 py-1.5 ring-1 ring-rule ring-inset">
          <dd className="font-mono text-base text-ink tabular-nums">{value}</dd>
          <dt className="text-[11px] text-ink-3">{label}</dt>
        </div>
      ))}
    </dl>
  );
}

export function OverviewCard({ o }: { o: Out<"get_overview"> }) {
  return (
    <Card eyebrow={`Overview · ${o.account ?? ""}`} asOf={o.asOf} link={o.link}>
      <Figures
        items={[
          ["need a person", o.counts.needsAPerson],
          ["running now", o.counts.runningNow],
          ["open PRs", `${o.counts.openPrsProven}/${o.counts.openPrs}`],
          ["reaching code", o.counts.changesReachingCode],
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
              <span className="ml-auto shrink-0 font-mono text-[11px] text-attention">
                {until(d.deadline)}
              </span>
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
                className="row-link flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
              >
                {r.live ? <LiveDot /> : <span className="size-2" />}
                <span className="min-w-0 truncate text-sm text-ink">{r.fullName}</span>
                <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-ink-3">
                  <span title="changes reaching the code">{r.reaching}↯</span>
                  <span title="open PRs">{r.openPrs} PR</span>
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
        <span className="font-mono text-[10px] text-ink-3">{o.fixMode.file ?? o.fixMode.origin}</span>
      </div>
      {o.lastScan?.status === "failed" ? (
        <p className="text-xs text-broke">Last scan failed: {o.lastScan.error}</p>
      ) : null}
      <Figures
        items={[
          ["reaching code", o.reaching],
          ["need a person", o.needsPerson],
          ["open PRs", o.prs.length],
          ["recent runs", o.runs.length],
        ]}
      />
      {o.top.length ? (
        <ul className="flex flex-col gap-1">
          {o.top.map((g) => (
            <li key={g.key} className="flex items-center gap-2 text-xs">
              <SafeLink href={g.link} className="min-w-0 truncate text-ink">
                {g.title}
              </SafeLink>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-3">
                {g.sites} site{g.sites === 1 ? "" : "s"}
              </span>
            </li>
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

export function FindingsCard({ o }: { o: Out<"list_findings"> }) {
  return (
    <Card eyebrow={`Findings · ${o.repo}`} asOf={o.asOf} link={o.link}>
      <p className="font-mono text-[11px] text-ink-3">
        {o.counts.reaching} reaching · {o.counts.needsPerson} need a person · {o.counts.notReaching} checked,
        not reaching
      </p>
      <ul className="flex flex-col gap-1.5">
        {o.groups.slice(0, 8).map((g) => (
          <li key={g.key} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <SafeLink href={g.link} className="min-w-0 truncate text-sm text-ink">
                {g.title}
              </SafeLink>
              <span className="ml-auto shrink-0">
                <VerdictChip verdict={g.verdict} />
              </span>
            </span>
            {g.firstSite ? (
              <span className="font-mono text-[11px] text-ink-3">
                {g.firstSite.file}:{g.firstSite.line}
                {g.sites > 1 ? ` +${g.sites - 1}` : ""}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function FindingCard({ o }: { o: Out<"get_finding"> }) {
  return (
    <Card eyebrow={`Finding · ${o.repo}`} asOf={o.change?.checkedAt ?? o.asOf} link={o.link}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{o.title}</span>
        <VerdictChip verdict={o.verdict} />
        {o.deadline ? (
          <span className="font-mono text-[11px] text-attention">{until(o.deadline)}</span>
        ) : null}
      </div>
      {o.change?.quote ? (
        <blockquote className="border-l-2 border-rule-strong pl-2 text-xs text-ink-2">
          {o.change.quote}
          <span className="mt-1 block font-mono text-[10px] text-ink-3">
            the provider's words · <SafeLink href={o.change.link}>change record</SafeLink>
          </span>
        </blockquote>
      ) : null}
      {o.change?.replacement ? (
        <p className="text-xs text-ink-2">
          Replace with <code className="font-mono text-ink">{o.change.replacement}</code>
        </p>
      ) : null}
      {o.sites.length ? (
        <ul className="flex flex-col gap-1">
          {o.sites.map((s) => (
            <li
              key={`${s.file}:${s.line}`}
              className="rounded-md bg-sunken px-2 py-1 ring-1 ring-rule ring-inset"
            >
              <span className="font-mono text-[10px] text-ink-3">
                {s.file}:{s.line} · {s.resolution}
              </span>
              <pre className="overflow-x-auto font-mono text-[11px] text-ink">{s.code}</pre>
            </li>
          ))}
          {o.moreSites ? <li className="text-[11px] text-ink-3">and {o.moreSites} more</li> : null}
        </ul>
      ) : null}
      {o.run ? <RunLine run={o.run} /> : null}
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
      {explained?.meaning ? <p className="text-xs text-ink-2">{explained.meaning}</p> : null}
      <p className="font-mono text-[11px] text-ink-3">
        {o.status} · {o.backend ?? "no sandbox"} · {ms(o.durationMs)} · ${o.costUsd.toFixed(3)} ·{" "}
        {o.modelCalls} model calls
      </p>
      {o.ledger.length ? (
        <table className="w-full font-mono text-[11px]">
          <thead>
            <tr className="text-left text-ink-3">
              <th className="font-normal">check</th>
              <th className="font-normal">before</th>
              <th className="font-normal">after</th>
            </tr>
          </thead>
          <tbody>
            {o.ledger.map((c) => {
              const side = (s: (typeof c)["before"]) =>
                s
                  ? s.total !== null
                    ? `${s.passed}/${s.total}`
                    : s.exit === 0
                      ? "pass"
                      : `exit ${s.exit}`
                  : "–";
              const broke = c.before?.exit === 0 && c.after && c.after.exit !== 0;
              return (
                <tr key={c.check} className="text-ink">
                  <td>{c.check}</td>
                  <td>{side(c.before)}</td>
                  <td className={cn(broke && "text-broke")}>{side(c.after)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
      <ul className="flex flex-col gap-1">
        {o.changes.slice(0, 8).map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-xs">
            <SafeLink href={c.link} className="min-w-0 truncate text-ink">
              {c.title}
            </SafeLink>
            {c.deadline ? (
              <span className="ml-auto shrink-0 font-mono text-[11px] text-attention">
                {until(c.deadline)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

type Reach = Out<"affected_by_change">["reaches"][number];

function PlanLine({ r }: { r: Reach }) {
  const p = r.plan;
  const said =
    p.kind === "open"
      ? `PR #${p.number} open`
      : p.kind === "running"
        ? "a run is going"
        : p.kind === "off"
          ? `fixes off (${p.why})`
          : p.kind === "paused"
            ? "Teire paused"
            : (p.waits ?? "Fix now starts a run");
  return (
    <li className="flex items-center gap-2 text-xs">
      <SafeLink href={`/app/repos/${r.repo}`} className="min-w-0 truncate text-ink">
        {r.repo}
      </SafeLink>
      <span className="font-mono text-[11px] text-ink-3">{r.sites} sites</span>
      <span className="ml-auto shrink-0 text-[11px] text-ink-2">{said}</span>
    </li>
  );
}

export function ChangeCard({ o }: { o: Out<"get_change"> }) {
  return (
    <Card eyebrow="Change" asOf={o.asOf} link={o.link} linkLabel="Open the change">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{o.title}</span>
        {o.deadline ? <StatusChip tone="attention">{until(o.deadline)}</StatusChip> : null}
      </div>
      {o.quote ? (
        <blockquote className="border-l-2 border-rule-strong pl-2 text-xs text-ink-2">
          {o.quote}
          <span className="mt-1 block font-mono text-[10px] text-ink-3">
            the provider's words{o.trustBasis ? ` · ${o.trustBasis.replace(/_/g, " ")}` : ""}
          </span>
        </blockquote>
      ) : (
        <p className="text-xs text-ink-2">{o.summary}</p>
      )}
      {o.replacement ? (
        <p className="text-xs text-ink-2">
          Replace with <code className="font-mono text-ink">{o.replacement}</code>
        </p>
      ) : null}
      {o.reaches.length ? (
        <ul className="flex flex-col gap-1">
          {o.reaches.map((r) => (
            <PlanLine key={`${r.repo}:${r.groupKey}`} r={r} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-3">It doesn't reach any of your repositories.</p>
      )}
    </Card>
  );
}

export function ReachCard({ o }: { o: Out<"affected_by_change"> }) {
  return (
    <Card
      eyebrow={`Reaches ${o.reaches.length} repositor${o.reaches.length === 1 ? "y" : "ies"}`}
      asOf={o.asOf}
      link={o.link}
    >
      {o.title ? <span className="font-medium text-ink">{o.title}</span> : null}
      {o.reaches.length ? (
        <ul className="flex flex-col gap-1">
          {o.reaches.map((r) => (
            <PlanLine key={`${r.repo}:${r.groupKey}`} r={r} />
          ))}
        </ul>
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
      <p className="font-mono text-[10px] text-ink-3">from {o.source}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {Object.entries(o.values).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="truncate text-ink">{show(v)}</dd>
          </div>
        ))}
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

export function UsageCard({ o }: { o: Out<"get_usage"> }) {
  const share = Math.min(100, (o.assistant.todayUsd / o.assistant.dailyCapUsd) * 100);
  return (
    <Card eyebrow="Usage · 30 days" asOf={o.asOf} link={o.link}>
      <Figures
        items={[
          ["runs", o.runs],
          ["sandbox min", o.sandboxMinutes],
          ["model $", `$${o.byPurpose.reduce((s, p) => s + p.costUsd, 0).toFixed(2)}`],
          ["Ask Teire $", `$${o.assistant.monthUsd.toFixed(2)}`],
        ]}
      />
      <div className="flex flex-col gap-1">
        <span className="flex justify-between text-[11px] text-ink-3">
          <span>Ask Teire today</span>
          <span className="font-mono">
            ${o.assistant.todayUsd.toFixed(3)} of ${o.assistant.dailyCapUsd.toFixed(2)}
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
            <span className="line-clamp-2 text-[11px] text-ink-3">{r.snippet}</span>
          </li>
        ))}
        {!o.results.length ? <li className="text-sm text-ink-3">Nothing in the docs matches.</li> : null}
      </ul>
    </Card>
  );
}

const GATE_ICON = {
  ok: <Check className="size-3.5 text-proven" aria-label="passed" />,
  holds: <CircleAlert className="size-3.5 text-attention" aria-label="holds it" />,
  note: <Info className="size-3.5 text-ink-3" aria-label="worth knowing" />,
};

export function WhyCard({ o }: { o: Out<"why_no_pr"> }) {
  return (
    <Card eyebrow={`Why no PR · ${o.repo}`} asOf={o.asOf} link={o.link}>
      <p className="text-sm font-medium text-ink">{o.answer}</p>
      <ol className="flex flex-col gap-1">
        {o.gates.map((g) => (
          <li key={`${g.gate}:${g.said}`} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 shrink-0">{GATE_ICON[g.state]}</span>
            <span className="w-20 shrink-0 font-mono text-[11px] text-ink-3">{g.gate}</span>
            <span className={cn("text-ink-2", g.state === "holds" && "text-ink")}>
              {g.href ? <SafeLink href={g.href}>{g.said}</SafeLink> : g.said}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function StepsCard({ o }: { o: Out<"show_steps"> }) {
  return (
    <Card eyebrow="How to">
      <span className="font-medium text-ink">{o.title}</span>
      <ol className="flex flex-col gap-1.5">
        {o.steps.map((s, i) => (
          <li key={s.text} className="flex items-start gap-2 text-sm">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sunken font-mono text-[10px] text-ink-2 ring-1 ring-rule ring-inset">
              {i + 1}
            </span>
            <span className="text-ink-2">
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

/**
 * The only way Ask Teire changes anything (D119): the exact action, its scope, Confirm and Cancel.
 * Confirm posts the server-signed proposal; the card then follows the action to the worker's word.
 */
export function ActionCard({ o }: { o: Proposed }) {
  const [state, setState] = useState<"idle" | "sending" | "cancelled">("idle");
  const [action, setAction] = useState<ActionRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposal = "proposal" in o ? o : "alternative" in o ? o.alternative : null;

  useEffect(() => {
    if (!action || TERMINAL.has(action.status as ActionStatus)) return;
    let alive = true;
    const t = setTimeout(async () => {
      const res = await fetch(`/api/actions/${action.id}`, { cache: "no-store" }).catch(() => null);
      if (alive && res?.ok) setAction((await res.json()) as ActionRow);
      else if (alive) setAction({ ...action });
    }, 1000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [action]);

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
    <Card eyebrow={action ? "Action" : "Proposed action"} tone="signal">
      {refused ? <p className="text-sm text-ink-2">{refused}</p> : null}
      {proposal ? (
        <>
          <p className="text-sm font-medium text-ink">{proposal.effect}</p>
          {"means" in proposal && proposal.means ? (
            <p className="text-xs text-ink-2">{String(proposal.means)}</p>
          ) : null}
          {"why" in proposal && proposal.why && !("means" in proposal && proposal.means) ? (
            <p className="text-xs text-ink-2">{proposal.why}</p>
          ) : null}
          {"note" in proposal && proposal.note ? (
            <p className="font-mono text-[10px] text-ink-3">{proposal.note}</p>
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
