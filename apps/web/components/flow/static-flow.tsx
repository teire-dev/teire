import { Fragment } from "react";
import {
  FLOW_STATE_LABEL,
  type FlowGraph,
  type FlowLink,
  type FlowState,
  type FlowTile,
} from "@/lib/flow/model";
import { cn } from "@/lib/utils";
import { TILE_SIZE, TileLabel, type TileSize, TileSquare } from "./tile";

/**
 * A flow drawn on the server (plan revision 3.4, B2 `explain`): tiles joined by connectors that meet
 * the squares at small round handles, n8n's grammar. From `md` up it runs left to right with each
 * label hanging under its square; on phones it is a left-aligned vertical timeline with the label
 * beside the square. One piece of markup, flex connectors (not placed paths), so the lines stay on
 * the squares at every width; no graph library and no hydration jump. A live connector carries a
 * travelling dot, hidden under reduced motion.
 */
const LINE: Record<FlowState, string> = {
  pending: "border-dashed border-ink-3/45",
  live: "border-signal",
  done: "border-ink/40",
  proven: "border-proven",
  not_proven: "border-attention",
  failed: "border-dashed border-broke",
  skipped: "border-dashed border-rule-strong",
};

const HANDLE: Record<FlowState, string> = {
  pending: "bg-sheet ring-ink-3/50",
  live: "bg-signal ring-signal",
  done: "bg-sheet ring-ink/45",
  proven: "bg-proven ring-proven",
  not_proven: "bg-attention ring-attention",
  failed: "bg-sheet ring-broke",
  skipped: "bg-sheet ring-rule-strong",
};

export function Connector({
  link,
  axis = "responsive",
  className,
}: {
  link: Pick<FlowLink, "state" | "label">;
  /** `x` keeps it horizontal at every width (short flows that fit a phone). */
  axis?: "responsive" | "x";
  className?: string;
}) {
  const x = axis === "x";
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex shrink-0",
        // Phones: a vertical segment under the squares' centre. md+: a horizontal one at their middle.
        x
          ? "h-[var(--tile)] w-12 sm:w-16"
          : "h-9 w-[var(--tile)] md:h-[var(--tile)] md:w-auto md:min-w-24 md:flex-1",
        className,
      )}
    >
      <span
        className={cn(
          "absolute",
          x
            ? "top-1/2 right-1.5 left-1.5 border-t-[1.5px]"
            : "top-0 bottom-0 left-[calc(var(--tile)/2)] border-l-[1.5px] md:top-1/2 md:right-1.5 md:bottom-auto md:left-1.5 md:border-t-[1.5px] md:border-l-0",
          LINE[link.state],
        )}
      />
      {/* n8n's handles: a small ring where the line meets each square (where lines are horizontal). */}
      <span
        className={cn(
          "absolute top-1/2 left-0 size-2 -translate-y-1/2 rounded-full ring-[1.5px]",
          x ? "block" : "hidden md:block",
          HANDLE[link.state],
        )}
      />
      <span
        className={cn(
          "absolute top-1/2 right-0 size-2 -translate-y-1/2 rounded-full ring-[1.5px]",
          x ? "block" : "hidden md:block",
          HANDLE[link.state],
        )}
      />
      {link.state === "live" ? (
        <span className="absolute top-0 left-[calc(var(--tile)/2-4px)] size-2 rounded-full bg-signal shadow-[0_0_0_3px_var(--signal-soft)] [animation:travel-y_1.2s_linear_infinite] motion-reduce:hidden md:top-[calc(50%-4px)] md:left-1.5 md:[animation:travel-x_1.2s_linear_infinite]" />
      ) : null}
      {link.label ? (
        <span
          data-flow
          className="absolute top-1/2 left-[calc(var(--tile)+12px)] -translate-y-1/2 rounded-full bg-sheet px-2 py-0.5 font-mono text-[10.5px] whitespace-nowrap text-ink-2 shadow-card md:top-auto md:bottom-[calc(50%+4px)] md:left-1/2 md:w-max md:max-w-[calc(100%-0.75rem)] md:-translate-x-1/2 md:translate-y-0 md:text-center md:leading-tight md:whitespace-normal"
        >
          {link.label}
        </span>
      ) : null}
    </span>
  );
}

/** A tile in a flow: the square, and its label under it (md+) or beside it (phones). */
export function Station({
  tile,
  size = "md",
  at = "middle",
  fit = false,
}: {
  tile: FlowTile;
  size?: TileSize;
  /** The first and last labels align to the flow's edges so they never hang off it. */
  at?: "start" | "middle" | "end";
  /** In a `StaticFlow`: centred, as wide as the flow leaves room for (`--label`), wrapping. */
  fit?: boolean;
}) {
  return (
    <span className="relative flex items-center gap-3 md:block">
      <TileSquare tile={tile} size={size} />
      <TileLabel
        tile={tile}
        size={size}
        className={cn(
          "items-start text-left md:absolute md:top-[calc(100%+10px)]",
          fit
            ? "md:left-1/2 md:w-[var(--label)] md:-translate-x-1/2 md:items-center md:text-center md:text-balance"
            : at === "start"
              ? "md:left-0 md:w-40 md:items-start md:text-left"
              : at === "end"
                ? "md:right-0 md:w-40 md:items-end md:text-right"
                : "md:left-1/2 md:w-40 md:-translate-x-1/2 md:items-center md:text-center",
        )}
      />
    </span>
  );
}

export function StaticFlow({
  graph,
  size = "md",
  label,
  className,
}: {
  graph: FlowGraph;
  size?: TileSize;
  /** What the whole flow shows, for screen readers ("How Teire fixed zod in teire-dev/examples"). */
  label: string;
  className?: string;
}) {
  const linkTo = new Map(graph.links.map((l) => [l.to, l]));
  const hasMeta = graph.tiles.some((t) => t.meta || t.caption);
  const n = graph.tiles.length;
  // Every label centred under its square and as wide as the flow leaves room for: with labels of
  // width L, a gap g between them and squares centred one label + gap apart, n labels fill the width
  // exactly when L = (width − (n − 1)·g) / n. Between 7rem and 10rem; below 7rem the flow scrolls
  // sideways instead of letting labels run into each other (B1, the commands diagram).
  const fit = {
    ["--tile" as string]: `${TILE_SIZE[size]}px`,
    ["--label" as string]: `clamp(7rem, calc((100cqw - ${n - 1} * 0.75rem) / ${n}), 10rem)`,
    ["--min" as string]: `calc(${n} * 7rem + ${n - 1} * 0.75rem)`,
  };
  return (
    <figure
      className={cn(
        "@container w-full md:overflow-x-auto md:pt-3 md:[scrollbar-width:thin]",
        hasMeta ? "md:pb-[4.5rem]" : "md:pb-10",
        className,
      )}
      style={fit}
    >
      <figcaption className="sr-only">{label}</figcaption>
      <ol className="flex flex-col md:min-w-[var(--min)] md:flex-row md:items-center md:px-[calc((var(--label)-var(--tile))/2)]">
        {graph.tiles.map((t, i) => {
          const link = linkTo.get(t.id);
          return (
            <Fragment key={t.id}>
              {i > 0 && link ? (
                <li aria-hidden className="contents">
                  <Connector link={link} className="md:min-w-0" />
                </li>
              ) : null}
              <li
                className="shrink-0"
                aria-label={`${t.label}, ${FLOW_STATE_LABEL[t.state]}${t.meta ? `, ${t.meta}` : ""}`}
              >
                <Station tile={t} size={size} fit />
              </li>
            </Fragment>
          );
        })}
      </ol>
    </figure>
  );
}
