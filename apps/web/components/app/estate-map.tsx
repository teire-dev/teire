"use client";

import {
  Background,
  BackgroundVariant,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { ArrowUpRight, Check, GripVertical, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EDGE_TYPES, type FlowEdgeT, HANDLE_CLASS } from "@/components/flow/flow-edge";
import { StaticFlow } from "@/components/flow/static-flow";
import { TILE_ICON, TileSquare } from "@/components/flow/tile";
import { useCanvasMode } from "@/components/flow/use-canvas-mode";
import { Mark } from "@/components/teire/mark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type EstateGraph, type EstateTile, planTile } from "@/lib/estate";
import { FLOW_STATE_LABEL, type FlowGraph, type FlowTile } from "@/lib/flow/model";
import { cn } from "@/lib/utils";
import type { ChangeReach } from "@/lib/workspace";
import { runAction } from "./run-action";

/**
 * The estate map (plan revision 3.4, V4 and C8; n8n's canvas): what reaches your code on the left,
 * your repositories in the middle, what Teire has open on the right, each edge in its state and
 * weighted by what it carries, a dot travelling where a run is going. Drag a change onto a repository
 * it reaches to see what Fix now does there, then start it. "By source" groups the same reaches by
 * provider and ecosystem. Phones get the same repositories as a list.
 */
type View = "changes" | "sources";
type Data = { tile: EstateTile };
type TileNodeT = Node<Data, "tile">;
type CaptionNodeT = Node<{ text: string }, "caption">;

/** A card: the tile's square and its words beside it (n8n's wide node), so a column stays compact. */
const NODE_W = 212;
const NODE_H = 56;
const ROW = 72;
/** Room above the columns for their names, and around the whole map. */
const HEAD = 36;
const PAD = 24;
const COL_MIN = 250;
const COL_MAX = 470;

/** Who is being dragged, which repositories it reaches, and which one it is over. */
const Drag = createContext<{
  id: string | null;
  targets: Set<string>;
  over: string | null;
  /** A tile's own button: a change opens what it reaches, anything else goes to its page. */
  open: (id: string) => void;
}>({
  id: null,
  targets: new Set(),
  over: null,
  open: () => undefined,
});

const CAPTION_TONE: Record<string, string> = {
  live: "text-signal",
  not_proven: "text-attention",
  failed: "text-broke",
};

function TileNode({ id, data }: NodeProps<TileNodeT>) {
  const { tile } = data;
  const drag = useContext(Drag);
  const dragging = drag.id !== null;
  const target = drag.targets.has(id);
  return (
    <div
      className={cn(
        "group relative flex items-center gap-2.5 rounded-xl bg-sheet p-1.5 pr-3 shadow-tile ring-1 ring-rule transition-[opacity,box-shadow,transform] duration-200",
        tile.drag
          ? "cursor-grab active:cursor-grabbing"
          : tile.href
            ? "cursor-pointer hover:shadow-card-hover"
            : "",
        tile.state === "pending" && "bg-sunken/60 shadow-none",
        dragging && drag.id !== id && !target && "opacity-30",
        target && "ring-2 ring-signal",
        drag.over === id && "scale-[1.04] shadow-float",
        drag.id === id && "shadow-float",
      )}
      style={{ width: NODE_W, height: NODE_H }}
    >
      {tile.column > 0 ? (
        <Handle type="target" position={Position.Left} className={HANDLE_CLASS} isConnectable={false} />
      ) : null}
      <button
        type="button"
        onClick={() => drag.open(id)}
        aria-label={`${tile.label}${tile.meta ? `, ${tile.meta}` : ""}${tile.caption ? `, ${tile.caption}` : ""}${tile.drag ? ". Show where it reaches and fix it" : tile.href ? ". Open" : ""}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-sheet"
      >
        <TileSquare tile={tile} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "truncate text-[13px] font-medium leading-tight text-ink",
              tile.state === "pending" && "text-ink-2",
            )}
          >
            {tile.label}
          </span>
          {tile.meta || tile.caption ? (
            <span className="flex min-w-0 gap-1.5 truncate font-mono text-[11px] leading-tight text-ink-3">
              {tile.meta ? <span className="truncate">{tile.meta}</span> : null}
              {tile.caption ? (
                <span className={cn("shrink-0", CAPTION_TONE[tile.state] ?? "text-signal")}>
                  {tile.caption}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        {tile.drag ? (
          <GripVertical
            aria-hidden
            className="size-3.5 shrink-0 text-ink-3 opacity-60 group-hover:opacity-100"
          />
        ) : null}
      </button>
      {tile.column < 2 ? (
        <Handle type="source" position={Position.Right} className={HANDLE_CLASS} isConnectable={false} />
      ) : null}
    </div>
  );
}

function CaptionNode({ data }: NodeProps<CaptionNodeT>) {
  return <span className="eyebrow pointer-events-none block">{data.text}</span>;
}

const NODE_TYPES = { tile: TileNode, caption: CaptionNode };

/** The map's geometry for a container `width`: column spacing, scale and height. */
function frame(graph: EstateGraph, width: number) {
  const rows = Math.max(...[0, 1, 2].map((c) => graph.tiles.filter((t) => t.column === c).length), 1);
  const col = Math.min(Math.max((width - 2 * PAD - NODE_W) / 2, COL_MIN), COL_MAX);
  const graphW = 2 * col + NODE_W;
  const graphH = HEAD + (rows - 1) * ROW + NODE_H;
  const zoom = Math.min(1, (width - 2 * PAD) / graphW);
  return {
    col,
    rows,
    height: Math.round(graphH * zoom + 2 * PAD),
    viewport: { x: (width - graphW * zoom) / 2, y: PAD + HEAD * zoom, zoom },
  };
}

/**
 * Three fixed columns; each repository sits near the changes that reach it (the mean row of its
 * sources), so few lines cross. Columns are centred on the tallest one.
 */
function place(graph: EstateGraph, view: View, col: number): (TileNodeT | CaptionNodeT)[] {
  const cols: EstateTile[][] = [[], [], []];
  for (const t of graph.tiles) cols[t.column]?.push(t);
  const row = new Map((cols[0] ?? []).map((t, i) => [t.id, i]));
  const mean = (id: string) => {
    const from = graph.links.filter((l) => l.to === id).map((l) => row.get(l.from) ?? 0);
    return from.length ? from.reduce((a, b) => a + b, 0) / from.length : Number.POSITIVE_INFINITY;
  };
  // "N more" stays last; the rest by where their sources sit.
  cols[1] = [...(cols[1] ?? [])].sort((a, b) =>
    a.id === "r:more" ? 1 : b.id === "r:more" ? -1 : mean(a.id) - mean(b.id),
  );
  const tallest = Math.max(...cols.map((c) => c.length), 1);
  const nodes: (TileNodeT | CaptionNodeT)[] = [];
  cols.forEach((list, c) => {
    const top = ((tallest - list.length) * ROW) / 2;
    nodes.push({
      id: `caption-${c}`,
      type: "caption",
      position: { x: c * col + 4, y: -HEAD },
      draggable: false,
      selectable: false,
      data: { text: [view === "changes" ? "Changes" : "Sources", "Repositories", "Open now"][c] as string },
    });
    list.forEach((t, i) => {
      nodes.push({
        id: t.id,
        type: "tile",
        position: { x: c * col, y: top + i * ROW },
        width: NODE_W,
        height: NODE_H,
        draggable: !!t.drag,
        data: { tile: t },
      });
    });
  });
  return nodes;
}

const edgesOf = (graph: EstateGraph): FlowEdgeT[] =>
  graph.links.map((l) => ({
    id: `${l.from}->${l.to}`,
    source: l.from,
    target: l.to,
    type: "flow",
    data: {
      state: l.state,
      ...(l.label ? { label: l.label } : {}),
      ...(l.weight ? { weight: l.weight } : {}),
    },
  }));

function FixPreview({
  change,
  reach,
  onClose,
}: {
  change: EstateTile | null;
  reach: ChangeReach | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const open = !!change && !!reach;
  const repoName = reach?.repo.split("/")[1] ?? reach?.repo ?? "";
  const graph: FlowGraph | null =
    change && reach
      ? {
          tiles: [
            { ...change, id: "change", caption: undefined },
            { id: "repo", entity: "repository", state: "done", label: repoName },
            planTile(reach),
          ],
          links: [
            { from: "change", to: "repo", state: "done" },
            {
              from: "repo",
              to: "plan",
              state:
                { done: "done", live: "live", skipped: "skipped" }[planTile(reach).state as string] ??
                "pending",
            } as FlowGraph["links"][number],
          ],
        }
      : null;
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fix {change?.drag?.subject}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{reach?.repo}</DialogDescription>
        </DialogHeader>
        {graph ? (
          <StaticFlow
            graph={graph}
            label={`Fix ${change?.drag?.subject} in ${reach?.repo}`}
            className="py-2"
          />
        ) : null}
        {reach?.plan.kind === "run" && reach.plan.waits ? (
          <p className="text-xs text-attention">{reach.plan.waits}</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {reach?.plan.kind === "run" ? (
            <Button
              variant="cta"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await runAction(
                    { kind: "fix", repo: reach.repo, params: { target: reach.groupKey } },
                    { onSettled: () => router.refresh() },
                  );
                  onClose();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : null}
              Fix now
            </Button>
          ) : reach?.plan.kind === "open" && reach.plan.url ? (
            <Button asChild>
              <a href={reach.plan.url}>
                Open PR #{reach.plan.number}
                <ArrowUpRight data-icon="inline-end" aria-hidden />
              </a>
            </Button>
          ) : reach?.plan.kind === "running" ? (
            <Button asChild>
              <Link href={`/runs/${reach.plan.runId}`}>Open the run</Link>
            </Button>
          ) : reach ? (
            <Button asChild variant="outline">
              <Link href={`/app/repos/${reach.repo}/config`}>Fix mode</Link>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Canvas({
  graph,
  view,
  width,
  onPick,
  onPreview,
}: {
  graph: EstateGraph;
  view: View;
  width: number;
  /** A change's own button: show where it reaches. */
  onPick: (change: EstateTile) => void;
  /** A change dropped on a repository it reaches: that repository's Fix now. */
  onPreview: (change: EstateTile, reach: ChangeReach) => void;
}) {
  const router = useRouter();
  const flow = useReactFlow();
  const canvasMode = useCanvasMode();
  const geo = frame(graph, width);
  const seeded = useMemo(() => place(graph, view, geo.col), [graph, view, geo.col]);
  const [nodes, setNodes, onNodesChange] = useNodesState<TileNodeT | CaptionNodeT>(seeded);
  const edges = useMemo(() => edgesOf(graph), [graph]);
  const [drag, setDrag] = useState<{ id: string | null; targets: Set<string>; over: string | null }>({
    id: null,
    targets: new Set(),
    over: null,
  });
  const moved = useRef(false);
  const overRef = useRef<string | null>(null);
  // A refresh (a run started, a PR opened) or a new width re-places the tiles; the map stays at
  // full size when it fits and scales down evenly when it doesn't.
  const sig = JSON.stringify([geo.col, graph.tiles.map((t) => [t.id, t.state, t.meta, t.caption])]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the layout's signature
  useEffect(() => {
    setNodes(seeded);
    void flow.setViewport(geo.viewport);
  }, [sig, setNodes, flow]);
  const tileOf = (id: string) => graph.tiles.find((t) => t.id === id);
  const snapBack = (id: string) =>
    setNodes((ns) =>
      ns.map((n) =>
        n.id === id
          ? { ...n, zIndex: 0, position: seeded.find((s) => s.id === id)?.position ?? n.position }
          : n,
      ),
    );

  return (
    <Drag.Provider
      value={{
        ...drag,
        open: (id) => {
          // The click that ends a drag is not a click on the tile.
          if (moved.current) return;
          const tile = tileOf(id);
          if (tile?.drag) onPick(tile);
          else if (tile?.href) router.push(tile.href);
        },
      }}
    >
      <div className="relative w-full" style={{ height: geo.height }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onNodeDragStart={(_, n) => {
            moved.current = true;
            // The card rides above the repositories it passes over.
            setNodes((ns) => ns.map((x) => (x.id === n.id ? { ...x, zIndex: 1000 } : x)));
            const t = tileOf(n.id);
            setDrag({
              id: n.id,
              targets: new Set((t?.drag?.reaches ?? []).map((r) => `r:${r.repo}`)),
              over: null,
            });
          }}
          onNodeDrag={(event) => {
            // The repository under the pointer is the target, not whichever one the card overlaps.
            const at = "clientX" in event ? event : event.touches[0];
            if (!at) return;
            const p = flow.screenToFlowPosition({ x: at.clientX, y: at.clientY });
            const over =
              flow
                .getNodes()
                .find(
                  (x) =>
                    x.id.startsWith("r:") &&
                    x.id !== "r:more" &&
                    p.x >= x.position.x &&
                    p.x <= x.position.x + NODE_W &&
                    p.y >= x.position.y &&
                    p.y <= x.position.y + NODE_H,
                )?.id ?? null;
            overRef.current = over;
            setDrag((d) => (d.over === over ? d : { ...d, over }));
          }}
          onNodeDragStop={(_, n) => {
            const change = tileOf(n.id);
            const over = overRef.current ? tileOf(overRef.current) : undefined;
            overRef.current = null;
            setDrag({ id: null, targets: new Set(), over: null });
            snapBack(n.id);
            // The click that ends a drag is not a click on the tile.
            setTimeout(() => {
              moved.current = false;
            }, 0);
            if (!change?.drag || !over?.repo) return;
            const reach = change.drag.reaches.find((r) => r.repo === over.repo);
            if (reach) onPreview(change, reach);
            else toast(`${change.drag.subject} doesn't reach ${over.label}`);
          }}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          panOnDrag={false}
          defaultViewport={geo.viewport}
          minZoom={0.3}
          maxZoom={1}
          panOnScroll={false}
          proOptions={{ hideAttribution: true }}
          colorMode={canvasMode}
          aria-label="What reaches your repositories and what Teire has open"
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} />
        </ReactFlow>
      </div>
    </Drag.Provider>
  );
}

const COUNT_GLYPH = {
  "o:ready": { Icon: Check, tone: "text-proven" },
  "o:drafts": { Icon: null, tone: "text-attention" },
  "o:issues": { Icon: X, tone: "text-broke" },
} as const;

/** Phones: each repository on the map as a row, with what reaches it and what is open there. */
function EstateList({ graph, onPick }: { graph: EstateGraph; onPick: (change: EstateTile) => void }) {
  const repos = graph.tiles.filter((t) => t.column === 1);
  const changes = graph.tiles.filter((t) => t.drag);
  return (
    <>
      {changes.length ? (
        <ul className="flex gap-2 overflow-x-auto border-b border-rule py-3 [scrollbar-width:none]">
          {changes.map((c) => (
            <li key={c.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onPick(c)}
                className="flex items-center gap-2 rounded-full bg-sheet py-1 pr-3 pl-1 text-xs shadow-tile ring-1 ring-rule"
              >
                {c.brand ? <Mark brand={c.brand} size="sm" /> : null}
                <span className="max-w-32 truncate text-ink">{c.label}</span>
                {c.caption ? <span className="font-mono text-[10px] text-signal">{c.caption}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="flex flex-col divide-y divide-rule">
        {repos.map((r) => {
          const into = graph.links
            .filter((l) => l.to === r.id)
            .map((l) => graph.tiles.find((t) => t.id === l.from));
          const out = graph.links.filter((l) => l.from === r.id && l.to in COUNT_GLYPH);
          return (
            <li key={r.id}>
              <Link href={r.href ?? "/app/repos"} className="flex items-center gap-3 px-1 py-3">
                <TileSquare tile={r} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-ink">{r.label}</span>
                  <span className="truncate font-mono text-[11px] text-ink-3">{r.meta ?? ""}</span>
                </span>
                <span className="flex items-center -space-x-1.5">
                  {into.slice(0, 3).map((t) => {
                    if (!t) return null;
                    const Icon = TILE_ICON[t.entity];
                    return t.brand ? (
                      <Mark key={t.id} brand={t.brand} size="sm" className="ring-2 ring-sheet" />
                    ) : (
                      <span
                        key={t.id}
                        className={cn(
                          "flex size-6 items-center justify-center rounded-md bg-sunken ring-2 ring-sheet",
                          t.state === "not_proven" ? "text-attention" : "text-ink-2",
                        )}
                      >
                        <Icon className="size-3.5" aria-hidden />
                      </span>
                    );
                  })}
                </span>
                <span className="flex items-center gap-1.5 font-mono text-xs">
                  {out.map((l) => {
                    const g = COUNT_GLYPH[l.to as keyof typeof COUNT_GLYPH];
                    return (
                      <span
                        key={l.to}
                        className={cn("flex items-center gap-0.5", g.tone)}
                        title={`${l.weight ?? 1} ${l.to === "o:ready" ? "ready to merge" : l.to === "o:drafts" ? "drafts" : "issues"}`}
                      >
                        {g.Icon ? (
                          <g.Icon className="size-3" strokeWidth={3} aria-hidden />
                        ) : (
                          <span aria-hidden>◐</span>
                        )}
                        {l.weight ?? 1}
                        <span className="sr-only">
                          {l.to === "o:ready"
                            ? " ready to merge"
                            : l.to === "o:drafts"
                              ? " drafts"
                              : " issues"}
                        </span>
                      </span>
                    );
                  })}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Where a change reaches, each repository with what Fix now would do there: the drag, by keyboard or touch. */
function Reaches({
  change,
  onClose,
  onFix,
}: {
  change: EstateTile | null;
  onClose: () => void;
  onFix: (reach: ChangeReach) => void;
}) {
  return (
    <Dialog open={!!change} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            {change?.brand ? <Mark brand={change.brand} size="sm" /> : null}
            {change?.drag?.subject}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">{change?.meta ?? ""}</DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-80 flex-col divide-y divide-rule overflow-auto rounded-lg ring-1 ring-rule">
          {(change?.drag?.reaches ?? []).map((r) => (
            <li key={`${r.repo}-${r.groupKey}`} className="flex items-center gap-3 px-3 py-2">
              <TileSquare tile={planTile(r)} size="sm" className="!size-8" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-ink">{r.repo.split("/")[1]}</span>
                <span className="truncate font-mono text-[11px] text-ink-3">
                  {planTile(r).label}
                  {planTile(r).caption ? ` · ${planTile(r).caption}` : ""}
                </span>
              </span>
              <Button
                size="sm"
                variant={r.plan.kind === "run" ? "default" : "outline"}
                onClick={() => onFix(r)}
              >
                {r.plan.kind === "run" ? "Fix now" : "Open"}
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          {change?.href ? (
            <Button asChild variant="ghost">
              <Link href={change.href}>In Changes for you ›</Link>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EstateMap({ graphs }: { graphs: Record<View, EstateGraph> }) {
  const [view, setView] = useState<View>("changes");
  const [picked, setPicked] = useState<EstateTile | null>(null);
  const [preview, setPreview] = useState<{ change: EstateTile; reach: ChangeReach } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const graph = graphs[view];
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl bg-sheet shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-3">
        <h2 className="text-sm font-medium text-ink">Your estate</h2>
        <div className="flex items-center gap-3">
          {view === "changes" && graph.tiles.some((t) => t.drag) ? (
            <span className="hidden items-center gap-1.5 text-xs text-ink-3 md:flex">
              <GripVertical className="size-3.5" aria-hidden />
              Drag a change onto a repo to fix it
            </span>
          ) : null}
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={view}
            onValueChange={(v) => (v ? setView(v as View) : null)}
            aria-label="Group the map by"
          >
            <ToggleGroupItem value="changes">By change</ToggleGroupItem>
            <ToggleGroupItem value="sources">By source</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <div ref={box} className="hidden md:block">
        {width ? (
          <ReactFlowProvider key={view}>
            <Canvas
              graph={graph}
              view={view}
              width={width}
              onPick={setPicked}
              onPreview={(change, reach) => setPreview({ change, reach })}
            />
          </ReactFlowProvider>
        ) : (
          <div className="h-[420px]" />
        )}
      </div>
      <div className="px-3 md:hidden">
        <EstateList graph={graph} onPick={setPicked} />
      </div>
      {/* The same map as lists of links, in order, for screen readers. */}
      <nav aria-label="The estate as lists" className="sr-only">
        {[0, 1, 2].map((c) => (
          <ul key={c}>
            {graph.tiles
              .filter((t) => t.column === c)
              .map((t) => (
                <li key={t.id}>
                  <Link href={t.href ?? "/app"} tabIndex={-1}>
                    {t.label}: {FLOW_STATE_LABEL[t.state]}
                    {t.meta ? `, ${t.meta}` : ""}
                    {t.caption ? `, ${t.caption}` : ""}
                  </Link>
                </li>
              ))}
          </ul>
        ))}
      </nav>
      <Reaches
        change={picked}
        onClose={() => setPicked(null)}
        onFix={(reach) => {
          if (picked) setPreview({ change: picked, reach });
          setPicked(null);
        }}
      />
      <FixPreview
        change={preview?.change ?? null}
        reach={preview?.reach ?? null}
        onClose={() => setPreview(null)}
      />
    </section>
  );
}
