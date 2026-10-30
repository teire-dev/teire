import {
  Box,
  Check,
  CircleDot,
  Eye,
  FileCode2,
  FolderGit2,
  GitPullRequest,
  GitPullRequestDraft,
  ListChecks,
  type LucideIcon,
  Minus,
  Package,
  ScanSearch,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { FLOW_STATE_LABEL, type FlowEntity, type FlowState, type FlowTile } from "@/lib/flow/model";
import { cn } from "@/lib/utils";

/**
 * One tile of a flow (plan revision 3.4, the n8n grammar): a square that carries one real logo or
 * one icon, a one-to-three-word label under it, a figure, and a state ring with its glyph badge.
 * Server-safe (no hooks): static flows, MiniFlow cards and the React Flow node all render this.
 */
export const TILE_ICON: Record<FlowEntity, LucideIcon> = {
  change: Zap,
  repository: FolderGit2,
  code: FileCode2,
  update: Package,
  fix: Wrench,
  sandbox: Box,
  check: ListChecks,
  review: ScanSearch,
  outcome: GitPullRequest,
};

/** Each state's ring: solid colour for a result, dashed for not-yet, a pulse while Teire works. */
const RING: Record<FlowState, string> = {
  pending: "outline-dashed outline-[1.5px] outline-ink-3/55 -outline-offset-[1.5px]",
  live: "ring-2 ring-signal animate-live",
  done: "ring-[1.5px] ring-ink/70",
  proven: "ring-2 ring-proven",
  not_proven: "ring-2 ring-attention",
  failed: "ring-2 ring-broke",
  skipped: "outline-dashed outline-1 outline-rule-strong -outline-offset-1 opacity-55",
};

const BADGE: Record<FlowState, string> = {
  pending: "bg-sheet text-ink-3 ring-1 ring-ink-3/60",
  live: "bg-signal text-white dark:text-sheet",
  done: "bg-ink text-sheet",
  proven: "bg-proven text-white dark:text-sheet",
  not_proven: "bg-attention text-white dark:text-sheet",
  failed: "bg-broke text-white dark:text-sheet",
  skipped: "",
};

export const TILE_SIZE = { lg: 80, md: 64, sm: 44 } as const;
export type TileSize = keyof typeof TILE_SIZE;

function Badge({ state, size }: { state: FlowState; size: TileSize }) {
  if (state === "skipped") return null;
  const dim = size === "sm" ? "size-4 -right-1 -bottom-1" : "size-5 -right-1.5 -bottom-1.5";
  const glyph = size === "sm" ? "size-2.5" : "size-3";
  return (
    <span
      aria-hidden
      className={cn(
        "absolute flex items-center justify-center rounded-full ring-2 ring-canvas",
        dim,
        BADGE[state],
      )}
    >
      {state === "done" || state === "proven" ? (
        <Check className={glyph} strokeWidth={3.25} />
      ) : state === "failed" ? (
        <X className={glyph} strokeWidth={3.25} />
      ) : state === "live" ? (
        <span className="size-1.5 rounded-full bg-white dark:bg-sheet" />
      ) : state === "not_proven" ? (
        <span className="font-mono text-[10px] leading-none">◐</span>
      ) : (
        <Minus className={cn(glyph, "opacity-0")} />
      )}
    </span>
  );
}

export function outcomeIcon(label: string): LucideIcon {
  if (/draft/i.test(label)) return GitPullRequestDraft;
  if (/issue/i.test(label)) return CircleDot;
  if (/preview/i.test(label)) return Eye;
  return GitPullRequest;
}

/** The tile's square alone (no label): for the React Flow node, MiniFlow and dense rows. */
export function TileSquare({
  tile,
  size = "md",
  className,
}: {
  tile: Pick<FlowTile, "entity" | "state" | "brand" | "label">;
  size?: TileSize;
  className?: string;
}) {
  const Icon = tile.entity === "outcome" ? outcomeIcon(tile.label) : TILE_ICON[tile.entity];
  const px = TILE_SIZE[size];
  const wide = tile.brand?.wide;
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-tile bg-sheet shadow-tile transition-[box-shadow,translate]",
        RING[tile.state],
        className,
      )}
      style={{ width: wide ? px * 1.5 : px, height: px }}
    >
      {tile.brand ? (
        <BrandLogo
          light={tile.brand.light}
          dark={tile.brand.dark}
          alt=""
          className={cn(
            "w-auto",
            tile.state === "pending" && "opacity-50 grayscale",
            wide
              ? { lg: "h-6", md: "h-5", sm: "h-3.5" }[size]
              : { lg: "h-9 max-w-12", md: "h-7 max-w-10", sm: "h-5 max-w-7" }[size],
          )}
        />
      ) : (
        <Icon
          aria-hidden
          className={cn(
            { lg: "size-8", md: "size-6", sm: "size-[18px]" }[size],
            tile.state === "live" ? "text-signal" : tile.state === "pending" ? "text-ink-3" : "text-ink",
          )}
          strokeWidth={1.75}
        />
      )}
      <Badge state={tile.state} size={size} />
    </span>
  );
}

/** The words under (or beside) a tile: its label, its figure, and a caption when live, amber or red. */
/** A path-like label (`github.com/BurntSushi/toml`) may wrap after each slash rather than run out of its box. */
function breakable(label: string) {
  if (!label.includes("/")) return label;
  const parts = label.split("/");
  return parts.map((part, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the label's own segments, in order
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 ? (
        <>
          /<wbr />
        </>
      ) : null}
    </Fragment>
  ));
}

export function TileLabel({
  tile,
  size = "md",
  className,
}: {
  tile: Pick<FlowTile, "label" | "meta" | "caption" | "state">;
  size?: TileSize;
  className?: string;
}) {
  return (
    <span className={cn("flex max-w-[11rem] flex-col items-center gap-0.5 text-center", className)}>
      <span
        data-flow
        className={cn(
          "line-clamp-2 font-medium leading-tight text-ink [overflow-wrap:anywhere]",
          size === "sm" ? "text-xs" : "text-[13px]",
          tile.state === "pending" && "text-ink-2",
        )}
      >
        {breakable(tile.label)}
      </span>
      {tile.meta ? (
        <span data-flow className="font-mono text-[11px] leading-tight text-ink-3">
          {tile.meta}
        </span>
      ) : null}
      {tile.caption ? (
        <span
          data-flow
          className={cn(
            "text-[11px] leading-tight",
            tile.state === "failed"
              ? "text-broke"
              : tile.state === "not_proven"
                ? "text-attention"
                : "text-signal",
          )}
        >
          {tile.caption}
        </span>
      ) : null}
    </span>
  );
}

/** A full tile: square, label, figure and caption, linked when it has a destination. */
export function Tile({
  tile,
  size = "md",
  className,
}: {
  tile: FlowTile;
  size?: TileSize;
  className?: string;
}) {
  const body = (
    <>
      <TileSquare tile={tile} size={size} />
      <TileLabel tile={tile} size={size} />
    </>
  );
  const aria = `${tile.label}: ${FLOW_STATE_LABEL[tile.state]}${tile.meta ? `, ${tile.meta}` : ""}${tile.caption ? `, ${tile.caption}` : ""}`;
  const cls = cn("group/tile flex flex-col items-center gap-2.5", className);
  // A linked tile lifts on hover, so a tile that opens something looks like it does (revamp S3).
  const linked = "[&:hover>span:first-child]:-translate-y-px [&:hover>span:first-child]:shadow-card-hover";
  if (tile.href) {
    const external = tile.href.startsWith("http");
    return external ? (
      <a
        href={tile.href}
        className={cn(
          cls,
          linked,
          "rounded-tile outline-none focus-visible:ring-2 focus-visible:ring-signal",
        )}
        aria-label={aria}
      >
        {body}
      </a>
    ) : (
      <Link
        href={tile.href}
        className={cn(
          cls,
          linked,
          "rounded-tile outline-none focus-visible:ring-2 focus-visible:ring-signal",
        )}
        aria-label={aria}
      >
        {body}
      </Link>
    );
  }
  return (
    <span className={cls} role="img" aria-label={aria}>
      {body}
    </span>
  );
}
