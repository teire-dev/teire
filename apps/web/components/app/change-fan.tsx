import Link from "next/link";
import { TileSquare } from "@/components/flow/tile";
import { changeBrand } from "@/lib/estate";
import type { FlowState } from "@/lib/flow/model";
import { until } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { ChangeForYou, ChangeReach } from "@/lib/workspace";

/**
 * One change reaching your code (plan revision 3.4, V4): the change's tile fanning out to each
 * repository it reaches, every branch in what Fix now would do there (a PR open, a run going, waiting,
 * fixes off), and Fix in all beside it. The fan is a fixed SVG drawn on the server.
 */
const SHOWN = 5;
const ROW = 30;
const FAN = 56;

export function reachState(r: ChangeReach): FlowState {
  switch (r.plan.kind) {
    case "open":
      return "done";
    case "running":
      return "live";
    case "run":
      return "pending";
    default:
      return "skipped";
  }
}

const STROKE: Record<FlowState, string> = {
  pending: "var(--ink-3)",
  live: "var(--signal)",
  done: "color-mix(in oklab, var(--ink) 45%, transparent)",
  proven: "var(--proven)",
  not_proven: "var(--attention)",
  failed: "var(--broke)",
  skipped: "var(--rule-strong)",
};

function said(r: ChangeReach) {
  switch (r.plan.kind) {
    case "open":
      return `#${r.plan.number}`;
    case "running":
      return "running";
    case "off":
      return "off";
    case "paused":
      return "paused";
    default:
      return r.plan.waits ? "waits" : r.sites ? `${r.sites} site${r.sites === 1 ? "" : "s"}` : "starts";
  }
}

export function ChangeFan({
  change,
  focus,
  action,
}: {
  change: ChangeForYou;
  focus?: boolean;
  action?: React.ReactNode;
}) {
  const reaches = change.reaches.slice(0, SHOWN);
  const more = change.reaches.length - reaches.length;
  const rows = reaches.length + (more ? 1 : 0);
  const h = Math.max(rows, 1) * ROW;
  const brand = changeBrand(change);
  const repos = new Set(change.reaches.map((r) => r.repo)).size;
  const dated = change.deadline ? until(change.deadline) : null;
  const soon = change.deadline ? change.deadline.getTime() - Date.now() < 30 * 86_400_000 : false;
  return (
    <article
      id={`change-${change.id}`}
      className={cn(
        "grid gap-x-6 gap-y-4 rounded-xl bg-sheet p-4 shadow-card lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]",
        focus && "ring-2 ring-signal",
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <Link
          href={`/changes/${change.id}`}
          className="line-clamp-2 text-sm font-medium text-ink hover:underline"
        >
          {change.title}
        </Link>
        <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-3">
          {change.subject && !change.title.includes(change.subject) ? (
            <span className="truncate">{change.subject}</span>
          ) : null}
          {change.from || change.to ? (
            <span>
              {change.from ?? "?"} → {change.to ?? "?"}
            </span>
          ) : null}
          {dated ? (
            <span
              className={cn(
                "rounded-full px-2 py-0.5",
                change.deadline && change.deadline.getTime() < Date.now()
                  ? "bg-broke-soft text-broke"
                  : soon
                    ? "bg-attention-soft text-attention"
                    : "bg-sunken text-ink-2",
              )}
            >
              {dated}
            </span>
          ) : null}
        </span>
        {action ? <div className="mt-auto flex items-center gap-2 pt-1">{action}</div> : null}
      </div>
      <figure className="flex items-center">
        <figcaption className="sr-only">Reaches {repos} of your repositories</figcaption>
        <TileSquare
          tile={{
            entity: "change",
            state: change.reaches.some((r) => r.plan.kind === "running") ? "live" : "done",
            label: change.subject ?? change.title,
            ...(brand ? { brand } : {}),
          }}
          size="sm"
        />
        <svg
          width={FAN}
          height={h}
          viewBox={`0 0 ${FAN} ${h}`}
          aria-hidden
          className="shrink-0 overflow-visible"
        >
          {Array.from({ length: rows }, (_, i) => {
            const y = i * ROW + ROW / 2;
            const r = reaches[i];
            const state = r ? reachState(r) : "pending";
            return (
              <path
                key={y}
                d={`M0,${h / 2} C${FAN / 2},${h / 2} ${FAN / 2},${y} ${FAN},${y}`}
                fill="none"
                stroke={STROKE[state]}
                strokeWidth={1.5}
                strokeDasharray={state === "pending" || state === "skipped" ? "4 4" : undefined}
              />
            );
          })}
        </svg>
        <ul className="flex min-w-0 flex-1 flex-col">
          {reaches.map((r) => {
            const state = reachState(r);
            return (
              <li key={`${r.repo}-${r.groupKey}`} style={{ height: ROW }} className="flex items-center">
                <Link
                  href={
                    r.plan.kind === "open" && r.plan.url
                      ? r.plan.url
                      : r.plan.kind === "running"
                        ? `/runs/${r.plan.runId}`
                        : `/app/repos/${r.repo}/findings?group=${encodeURIComponent(r.groupKey)}`
                  }
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-full bg-sheet py-0.5 pr-2.5 pl-1 text-xs shadow-tile ring-1 ring-rule hover:ring-rule-strong",
                    state === "skipped" && "opacity-60",
                  )}
                  title={
                    r.plan.kind === "off"
                      ? `Fixes off (${r.plan.why})`
                      : r.plan.kind === "run" && r.plan.waits
                        ? r.plan.waits
                        : r.repo
                  }
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      state === "done"
                        ? "bg-ink"
                        : state === "live"
                          ? "animate-live bg-signal"
                          : state === "pending"
                            ? "ring-1 ring-ink-3"
                            : "bg-rule-strong",
                    )}
                  />
                  <span className="truncate text-ink">{r.repo.split("/")[1]}</span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-3">{said(r)}</span>
                </Link>
              </li>
            );
          })}
          {more ? (
            <li style={{ height: ROW }} className="flex items-center pl-2 font-mono text-[11px] text-ink-3">
              +{more} more
            </li>
          ) : null}
        </ul>
      </figure>
    </article>
  );
}
