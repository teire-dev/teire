"use client";

import { ArrowUpRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FLOW_STATE_LABEL, type FlowGraph, type FlowState, type FlowTile } from "@/lib/flow/model";
import { cn } from "@/lib/utils";
import { outcomeIcon, TILE_ICON, TileSquare } from "./tile";

/**
 * A run as a breadcrumb trail (plan revision 3.4, V4; the owner's "PRs as breadcrumbs"): one chevron
 * per step, interlocking, each carrying its step's logo, name and figure in its state's colour, so a
 * pull request reads left to right as what happened. A step opens its evidence in place (what it did,
 * its figure, why it is amber or red) with the run one click further; nobody leaves the list to read it.
 */
const FILL: Record<FlowState, string> = {
  pending: "bg-canvas text-ink-3",
  live: "bg-signal-soft text-signal",
  done: "bg-sunken text-ink",
  proven: "bg-proven-soft text-proven",
  not_proven: "bg-attention-soft text-attention",
  failed: "bg-broke-soft text-broke",
  // Skipped reads by its dashed-grey tone, not by fading: faded text fails contrast (V7 walk).
  skipped: "bg-canvas text-ink-3",
};

/** The arrow: a notch on the left (but not on the first), a point on the right. */
const NOTCH = 10;
const shape = (first: boolean) =>
  `polygon(0 0, calc(100% - ${NOTCH}px) 0, 100% 50%, calc(100% - ${NOTCH}px) 100%, 0 100%${first ? "" : `, ${NOTCH}px 50%`})`;

/**
 * A segment says the one thing that step adds: the figure where the step is generic (your code → "15
 * call sites", checks → "3/3 → 3/3", the sandbox → "Token Factory"), the name where it is the point
 * (the package, the updater, the model); the PR as "PR #20". The full words are in its popover.
 */
function words(t: FlowTile): { main: string; sub?: string } {
  if (t.entity === "code" || t.entity === "sandbox" || t.entity === "check")
    return { main: t.meta ?? t.label };
  if (t.entity === "outcome") {
    const n = t.meta?.replace(/^issue\s+/, "").replace(/\s*·\s*draft$/, "");
    return { main: `${t.label.replace(/^Pull request$/, "PR")}${n && !t.label.includes(n) ? ` ${n}` : ""}` };
  }
  return t.meta ? { main: t.label, sub: t.meta } : { main: t.label };
}

/** The checks' evidence word (`check` tiles only): what the colour means, said. */
const EVIDENCE: Partial<Record<FlowState, string>> = {
  proven: "proven",
  not_proven: "not proven",
  failed: "regression",
};

function Segment({ tile, first, runHref }: { tile: FlowTile; first: boolean; runHref?: string | undefined }) {
  const said = words(tile);
  const Icon = tile.entity === "outcome" ? outcomeIcon(tile.label) : TILE_ICON[tile.entity];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${tile.label}: ${FLOW_STATE_LABEL[tile.state]}${tile.meta ? `, ${tile.meta}` : ""}`}
          className={cn(
            "group/seg relative flex h-9 min-w-0 shrink-0 items-center gap-1.5 text-xs transition-[filter] outline-none hover:brightness-95 dark:hover:brightness-125",
            first ? "pl-2.5" : "-ml-[7px] pl-4",
            "pr-4",
            FILL[tile.state],
            tile.state === "live" && "animate-live",
          )}
          style={{ clipPath: shape(first) }}
        >
          {/* Focus can't draw outside the chevron's clip, so it draws inside: a bar along its foot. */}
          <span
            aria-hidden
            className="absolute inset-x-3 bottom-0.5 h-0.5 rounded-full bg-current opacity-0 group-focus-visible/seg:opacity-100"
          />
          {tile.brand ? (
            <BrandLogo
              light={tile.brand.light}
              dark={tile.brand.dark}
              alt=""
              className={cn("h-3.5 w-auto shrink-0", tile.brand.wide ? "max-w-12" : "max-w-4")}
            />
          ) : (
            <Icon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden />
          )}
          <span className="max-w-44 truncate font-medium">{said.main}</span>
          {said.sub ? (
            <span className="hidden min-w-0 truncate font-mono text-[11px] 2xl:inline">{said.sub}</span>
          ) : null}
          {/* The checks' verdict in words beside its colour (revamp S2): colour is never the only signal. */}
          {tile.entity === "check" && EVIDENCE[tile.state] ? (
            <span className="shrink-0 font-mono text-[10.5px] opacity-80">{EVIDENCE[tile.state]}</span>
          ) : null}
          {/* A segment opens its evidence in place: the caret says so. */}
          <ChevronDown className="size-3 shrink-0 opacity-50 group-hover/seg:opacity-90" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="flex items-start gap-3">
          <TileSquare tile={tile} size="sm" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium text-ink">{tile.label}</span>
            <span className="font-mono text-[11px] text-ink-3">{FLOW_STATE_LABEL[tile.state]}</span>
            {tile.meta ? <span className="font-mono text-xs text-ink-2">{tile.meta}</span> : null}
            {tile.caption ? (
              <span
                className={cn(
                  "text-xs",
                  tile.state === "failed"
                    ? "text-broke"
                    : tile.state === "not_proven"
                      ? "text-attention"
                      : "text-ink-2",
                )}
              >
                {tile.caption}
              </span>
            ) : null}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3 border-t border-rule pt-2.5 text-xs">
          {tile.href ? (
            <a href={tile.href} className="flex items-center gap-1 text-link hover:underline">
              Open <ArrowUpRight className="size-3" aria-hidden />
            </a>
          ) : null}
          {runHref ? (
            <Link
              href={`${runHref}?tile=${encodeURIComponent(tile.id)}`}
              className="ml-auto text-ink-2 hover:text-ink"
            >
              Its evidence on the run ›
            </Link>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function Trail({
  graph,
  runHref,
  omit = [],
  label,
  className,
}: {
  graph: FlowGraph;
  runHref?: string;
  /** Steps the page already says (the repository, on a repository's page). */
  omit?: FlowTile["entity"][];
  label: string;
  className?: string;
}) {
  const tiles = graph.tiles.filter(
    (t) => !omit.includes(t.entity) && (t.state !== "skipped" || t.entity === "outcome"),
  );
  // The pull request or issue on GitHub, one click from the list (revamp S2).
  const opened = tiles.find((t) => t.entity === "outcome" && t.href?.startsWith("https://github.com/"));
  return (
    <nav aria-label={label} className={cn("min-w-0", className)} data-flow>
      {/* Steps keep their size and the row scrolls sideways when it can't fit (a phone), never crushes. */}
      <ol className="flex min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tiles.map((t, i) => (
          <li key={t.id} className="flex shrink-0">
            <Segment tile={t} first={i === 0} runHref={runHref} />
          </li>
        ))}
        {opened?.href ? (
          <li className="flex shrink-0">
            <a
              href={opened.href}
              aria-label={`${opened.label} on GitHub`}
              title={`${opened.label} on GitHub`}
              className="ml-1.5 flex size-7 items-center justify-center rounded-full text-ink-3 ring-1 ring-rule ring-inset hover:text-ink hover:ring-rule-strong"
            >
              <ArrowUpRight className="size-3.5" aria-hidden />
            </a>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}
