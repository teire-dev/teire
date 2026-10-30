import { ChevronDown } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CallSites } from "@/components/findings/call-sites";
import { GraphStrip } from "@/components/flow/mini-flow";
import { StaticFlow } from "@/components/flow/static-flow";
import { Mark } from "@/components/teire/mark";
import type { FindingGroup } from "@/lib/findings";
import { type FlowGraph, type FlowState, type FlowTile, flowStateOf, shortDetail } from "@/lib/flow/model";
import { subjectMark, subjectOfKey } from "@/lib/marks";
import { until } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { RunRow } from "@/lib/workspace";

/**
 * One change group on a repository's Findings (plan revision 3.4, V4): the change, where it reaches
 * this code, the fix and its pull request as four tiles, each in its state; the call sites fold
 * underneath, each a line at the scanned commit. Actions (Fix now, Ignore, Explain) sit on the title.
 */
export interface FindingFlowProps {
  group: FindingGroup;
  repo: string;
  sha: string | null;
  /** The group's newest run, if any ran (on a public report, its dry run). */
  latest?: (Pick<RunRow, "id" | "status" | "proof"> & { by?: string }) | undefined;
  /** A public report: the run is a dry run, so its outcome is a PR preview, never a PR. */
  preview?: boolean;
  /** Its open PR or issue on GitHub. */
  opened?: { kind: string; number: number | null; url: string | null; state: string } | undefined;
  mode: "auto" | "ask" | "off";
  /** The code alone doesn't settle it: the sandbox run decides (rule 12). */
  undecided?: boolean;
  actions?: ReactNode;
  focus?: boolean;
  /** One row that opens to the full card (plan revision 3.4, B6); the focused group stays open. */
  compact?: boolean;
}

const HUMAN: Record<string, string> = { needs_human: "needs a person", check_by_hand: "check by hand" };

function fixTile(p: FindingFlowProps): FlowTile {
  const r = p.latest;
  if (r && ["queued", "running", "stopping"].includes(r.status))
    return {
      id: "fix",
      entity: "fix",
      state: "live",
      label: "Fixing",
      ...(r.by ? { meta: r.by } : {}),
      href: `/runs/${r.id}`,
    };
  if (r) {
    const fixed = flowStateOf(r.proof.fixed.state);
    const proven = flowStateOf(r.proof.proven.state, { verified: r.proof.proven.state === "done" });
    const state: FlowState =
      fixed === "failed" || proven === "failed" ? "failed" : proven === "skipped" ? fixed : proven;
    const caption = shortDetail(
      state === "failed" ? (r.proof.proven.detail ?? r.proof.fixed.detail) : undefined,
    );
    return {
      id: "fix",
      entity: "fix",
      state,
      label: "Fix",
      ...(r.proof.proven.detail && state !== "failed" ? { meta: shortDetail(r.proof.proven.detail) } : {}),
      ...(caption ? { caption } : r.by ? { caption: r.by } : {}),
      href: `/runs/${r.id}`,
    };
  }
  if (p.opened?.state === "open") return { id: "fix", entity: "fix", state: "done", label: "Fix" };
  if (p.group.key.startsWith("runtime/"))
    return { id: "fix", entity: "fix", state: "skipped", label: "By hand", caption: "no PR for a runtime" };
  if (p.mode === "off") return { id: "fix", entity: "fix", state: "skipped", label: "Fixes off" };
  if (p.undecided)
    return { id: "fix", entity: "sandbox", state: "pending", label: "Your checks", caption: "decide it" };
  return {
    id: "fix",
    entity: "fix",
    state: "pending",
    label: "Fix",
    ...(p.mode === "ask" ? { caption: "waits for you" } : {}),
  };
}

function outcomeTile(p: FindingFlowProps, fix: FlowTile): FlowTile {
  const o = p.opened;
  if (o?.number && o.state === "open") {
    const issue = o.kind === "issue";
    return {
      id: "out",
      entity: "outcome",
      state: issue
        ? "failed"
        : fix.state === "proven"
          ? "proven"
          : fix.state === "not_proven"
            ? "not_proven"
            : "done",
      label: `${issue ? "Issue" : fix.state === "not_proven" ? "Draft PR" : "PR"} #${o.number}`,
      ...(o.url ? { href: o.url } : {}),
    };
  }
  if (p.preview)
    return {
      id: "out",
      entity: "outcome",
      state: p.latest?.status === "succeeded" ? "done" : fix.state === "skipped" ? "skipped" : "pending",
      label: "PR preview",
      ...(p.latest ? { href: `/runs/${p.latest.id}` } : {}),
    };
  return {
    id: "out",
    entity: "outcome",
    state: fix.state === "skipped" ? "skipped" : "pending",
    label: "Pull request",
  };
}

/**
 * How far an advisory reaches this code, in a chip (S19): called (to the first line found), not
 * called, or the package only, when the advisory names no function to look for.
 */
function ReachChip({ group }: { group: FindingGroup }) {
  if (!group.key.startsWith("advisory/") && !group.rows.some((r) => r.kind === "security-advisory"))
    return null;
  const site = group.sites[0];
  const [label, tone] =
    group.reachability === "function-reachable"
      ? [
          site ? `Called at ${site.file}:${site.line}` : "Called from your code",
          "bg-affected-soft text-affected",
        ]
      : group.reachability === "function-not-reachable"
        ? ["Not called from your code", "bg-clear-soft text-clear"]
        : group.reachability === "package-present"
          ? ["Package present: the advisory names no function", "bg-sunken text-ink-3"]
          : ["Use not checked", "bg-sunken text-ink-3"];
  return <span className={cn("w-fit rounded-full px-2 py-0.5 font-mono text-[11px]", tone)}>{label}</span>;
}

export function FindingFlow(p: FindingFlowProps) {
  const { group } = p;
  const subject = subjectOfKey(group.key);
  const human = HUMAN[group.verdict];
  const sites = group.sites.length;
  const fix = fixTile(p);
  const out = outcomeTile(p, fix);
  const graph: FlowGraph = {
    tiles: [
      {
        id: "change",
        entity: "change",
        state: "done",
        label: subject.name,
        ...(subject.meta ? { meta: subject.meta } : {}),
        ...(group.deadline ? { caption: until(group.deadline) } : {}),
        brand: subjectMark(group.key),
        ...(group.changeIds[0] ? { href: `/changes/${group.changeIds[0]}` } : {}),
      },
      {
        id: "code",
        entity: "code",
        state: p.undecided ? "not_proven" : human ? "not_proven" : "done",
        label: sites
          ? `${sites} call site${sites === 1 ? "" : "s"}`
          : group.verdict === "affected"
            ? "Installed version"
            : "Your code",
        ...(p.undecided ? { caption: "unresolved" } : human ? { caption: human } : {}),
      },
      fix,
      out,
    ],
    links: [
      { from: "change", to: "code", state: "done" },
      {
        from: "code",
        to: "fix",
        state: fix.state === "skipped" ? "skipped" : fix.state === "pending" ? "pending" : "done",
      },
      { from: "fix", to: "out", state: out.state },
    ],
  };
  if (p.compact && !p.focus)
    return (
      <div id={`group-${group.key}`} className="relative">
        <details className="group/finding overflow-hidden rounded-xl bg-sheet shadow-card">
          <summary className="flex cursor-pointer list-none items-center gap-3 py-2.5 pr-44 pl-3 hover:bg-hover [&::-webkit-details-marker]:hidden">
            <Mark brand={subjectMark(group.key)} size="sm" />
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{group.title}</span>
            <GraphStrip graph={graph} className="hidden shrink-0 md:inline-flex" />
            <ChevronDown
              aria-hidden
              className="size-3.5 shrink-0 text-ink-3 transition-transform group-open/finding:rotate-180"
            />
          </summary>
          <div className="flex flex-col gap-3 border-t border-rule p-4">
            <StaticFlow
              graph={graph}
              size="sm"
              label={`${group.title}: from the change to its pull request`}
            />
            <ReachChip group={group} />
            {human && group.reason ? <p className="text-xs text-ink-3">{group.reason}</p> : null}
            {sites ? <CallSites sites={group.sites} repo={p.repo} sha={p.sha} /> : null}
          </div>
        </details>
        {p.actions ? (
          <div className="absolute top-1.5 right-10 flex items-center gap-1">{p.actions}</div>
        ) : null}
      </div>
    );
  return (
    <article
      id={`group-${group.key}`}
      className={cn(
        "grid gap-x-6 gap-y-3 rounded-xl bg-sheet p-4 shadow-card lg:grid-cols-[minmax(0,1fr)_minmax(0,500px)]",
        p.focus && "ring-2 ring-signal",
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <header className="flex items-start justify-between gap-3">
          {group.changeIds[0] ? (
            <Link
              href={`/changes/${group.changeIds[0]}`}
              className="line-clamp-2 min-w-0 text-sm font-medium text-ink hover:underline"
              title={group.key}
            >
              {group.title}
            </Link>
          ) : (
            <span className="line-clamp-2 min-w-0 text-sm font-medium text-ink" title={group.key}>
              {group.title}
            </span>
          )}
          {p.actions ? <div className="flex shrink-0 items-center gap-1">{p.actions}</div> : null}
        </header>
        <ReachChip group={group} />
        {human && group.reason ? <p className="line-clamp-2 text-xs text-ink-3">{group.reason}</p> : null}
        {sites ? (
          <details className="group/sites">
            <summary className="w-fit cursor-pointer list-none font-mono text-[11px] text-ink-3 hover:text-ink [&::-webkit-details-marker]:hidden">
              <span className="group-open/sites:hidden">Show</span>
              <span className="hidden group-open/sites:inline">Hide</span> the {sites} line
              {sites === 1 ? "" : "s"}
            </summary>
            <div className="pt-2">
              <CallSites sites={group.sites} repo={p.repo} sha={p.sha} />
            </div>
          </details>
        ) : null}
      </div>
      <StaticFlow graph={graph} size="sm" label={`${group.title}: from the change to its pull request`} />
    </article>
  );
}
