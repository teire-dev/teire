"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  useNodesState,
} from "@xyflow/react";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EDGE_TYPES, type FlowEdgeT, HANDLE_CLASS } from "@/components/flow/flow-edge";
import { TileLabel, TileSquare } from "@/components/flow/tile";
import { useCanvasMode } from "@/components/flow/use-canvas-mode";
import { FLOW_STATE_LABEL, type FlowGraph, type FlowTile } from "@/lib/flow/model";
import { cn } from "@/lib/utils";

/**
 * The run as a canvas (plan revision 3.4, V3; n8n's execution view): the run's tiles on React Flow,
 * draggable (positions kept per run in this browser, with Reset), a dot travelling into the live
 * tile, and a click (or Enter) on a tile opening its evidence in the inspector. The poll changes only
 * the tiles' data: ids and positions stay, so nothing remounts or jumps. The page never scrolls into a
 * zoom: wheel scrolling passes through, pinch and the controls zoom.
 */
/** `flip`: the tile sits on a right-to-left row of the snake, so it takes edges on its right. */
type TileData = { tile: FlowTile; selected: boolean; onSelect: (id: string) => void; flip?: boolean };
type TileNodeT = Node<TileData, "tile">;

const GAP = 132;
const ROW = 184;
const SIZE = 64;
/**
 * Room the fitted view keeps around the tiles, in pixels: what a column count is measured against.
 * A label is 144px under a 64px tile, so each side needs its 40px overhang and a little air, or the
 * first and last labels are cut at the canvas edge (`github.com/BurntSushi/toml`).
 */
const EDGE = 48;
const SIDE = EDGE * 2;

function TileNode({ id, data }: NodeProps<TileNodeT>) {
  const { tile, selected, onSelect, flip } = data;
  return (
    <div className="relative" style={{ width: SIZE, height: SIZE }}>
      <Handle
        type="target"
        position={flip ? Position.Right : Position.Left}
        className={HANDLE_CLASS}
        isConnectable={false}
      />
      <button
        type="button"
        onClick={() => onSelect(id)}
        aria-pressed={selected}
        aria-label={`${tile.label}: ${FLOW_STATE_LABEL[tile.state]}${tile.meta ? `, ${tile.meta}` : ""}${tile.caption ? `, ${tile.caption}` : ""}. Show its evidence`}
        className={cn(
          "nodrag rounded-tile outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2",
          selected && "ring-2 ring-signal ring-offset-4 ring-offset-canvas",
        )}
      >
        <TileSquare tile={tile} size="md" />
      </button>
      <Handle
        type="source"
        position={flip ? Position.Left : Position.Right}
        className={HANDLE_CLASS}
        isConnectable={false}
      />
      <TileLabel
        tile={tile}
        className="pointer-events-none absolute top-[calc(100%+10px)] left-1/2 w-36 -translate-x-1/2"
      />
    </div>
  );
}

// Module-level, so React Flow never sees a new type map and remounts the nodes (plan 3.4, A4).
const nodeTypes = { tile: TileNode };

// Kept per run and per column count: a layout dragged at one width never lands outside another's
// rows (V7 final review).
const storeKey = (runId: string, cols: number) => `teire:run-canvas:${runId}:${cols}`;
function savedPositions(runId: string, cols: number): Record<string, { x: number; y: number }> {
  try {
    return JSON.parse(localStorage.getItem(storeKey(runId, cols)) ?? "{}");
  } catch {
    return {};
  }
}

export function RunCanvas({
  runId,
  graph,
  selected,
  onSelect,
  caption,
  className,
}: {
  runId: string;
  graph: FlowGraph;
  selected: string | null;
  onSelect: (id: string) => void;
  /** What Teire is doing now (the live step, present tense), announced politely. */
  caption?: string | null;
  className?: string;
}) {
  // The tiles wrap into rows by the canvas's own width, so they stay at full size with readable
  // labels (V7 walk: one fitted row shrank them to ~8px text beside the inspector).
  const box = useRef<HTMLDivElement>(null);
  const count = graph.tiles.length;
  const [cols, setCols] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      setCols(Math.max(3, Math.min(count, Math.floor((w - SIDE + GAP - SIZE) / GAP))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [count]);
  // A snake (V7 final review): odd rows run right to left, so a row's last tile and the next row's
  // first sit one above the other and the edge between them is a short bracket at the side, never a
  // loop back over the row.
  const flipOf = useCallback((i: number) => Math.floor(i / (cols ?? count)) % 2 === 1, [cols, count]);
  const place = useCallback(
    (i: number) => {
      const c = cols ?? count;
      const col = i % c;
      return { x: (flipOf(i) ? c - 1 - col : col) * GAP, y: Math.floor(i / c) * ROW };
    },
    [cols, count, flipOf],
  );
  // Seeded once (the parent keys this canvas by its set of tiles); the poll updates data, never positions.
  const [nodes, setNodes, onNodesChange] = useNodesState<TileNodeT>(
    graph.tiles.map((t, i) => ({
      id: t.id,
      type: "tile",
      position: { x: i * GAP, y: 0 },
      width: SIZE,
      height: SIZE,
      data: { tile: t, selected: t.id === selected, onSelect },
    })),
  );
  // A new column count lays the tiles out for it, with whatever this person dragged at that count.
  useEffect(() => {
    if (cols === null) return;
    const saved = savedPositions(runId, cols);
    setNodes((ns) =>
      ns.map((n, i) => ({
        ...n,
        data: { ...n.data, flip: flipOf(i) },
        position: (saved[n.id] as { x: number; y: number } | undefined) ?? place(i),
      })),
    );
  }, [cols, place, flipOf, runId, setNodes]);
  const rows = Math.ceil(count / (cols ?? count));
  // React Flow puts its own `light`/`dark` class on the canvas; it must match the app's theme or the
  // `.light` token pin would keep light ink on a dark page.
  const canvasMode = useCanvasMode();

  // The poll: merge each tile's new data by id, keep where it sits.
  useEffect(() => {
    const byId = new Map(graph.tiles.map((t) => [t.id, t]));
    setNodes((ns) =>
      ns.map((n) => {
        const tile = byId.get(n.id);
        return tile ? { ...n, data: { ...n.data, tile, selected: n.id === selected, onSelect } } : n;
      }),
    );
  }, [graph, selected, onSelect, setNodes]);

  const edges = useMemo<FlowEdgeT[]>(
    () =>
      graph.links.map((l) => ({
        id: `${l.from}-${l.to}`,
        source: l.from,
        target: l.to,
        type: "step",
        data: { state: l.state },
      })),
    [graph.links],
  );

  const keep = useCallback(
    (_: unknown, node: TileNodeT) => {
      if (cols === null) return;
      const saved = savedPositions(runId, cols);
      saved[node.id] = node.position;
      try {
        localStorage.setItem(storeKey(runId, cols), JSON.stringify(saved));
      } catch {}
    },
    [runId, cols],
  );
  const reset = () => {
    try {
      if (cols !== null) localStorage.removeItem(storeKey(runId, cols));
    } catch {}
    setNodes((ns) => ns.map((n, i) => ({ ...n, position: place(i) })));
  };

  return (
    <div
      ref={box}
      className={cn("relative w-full transition-opacity", cols === null && "opacity-0", className)}
      style={{ height: Math.max(240, rows * ROW + 110) }}
    >
      <ReactFlow
        // Refit when the tiles wrap differently (a resize), never on a poll.
        key={cols ?? 0}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={keep}
        nodesConnectable={false}
        elementsSelectable={false}
        // The tile's own button is the one tab stop (not React Flow's wrapper as well).
        nodesFocusable={false}
        edgesFocusable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        panOnScroll={false}
        fitView
        fitViewOptions={{
          padding: { top: "48px", bottom: "64px", left: `${EDGE}px`, right: `${EDGE}px` },
          maxZoom: 1,
        }}
        minZoom={0.4}
        proOptions={{ hideAttribution: true }}
        maxZoom={1.6}
        aria-label="The run, tile by tile"
        colorMode={canvasMode}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} />
        <Controls showInteractive={false} position="top-left" orientation="horizontal" />
      </ReactFlow>
      <button
        type="button"
        onClick={reset}
        className="absolute top-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-sheet px-2.5 py-1 text-[11px] text-ink-2 shadow-card hover:text-ink"
      >
        <RotateCcw className="size-3" />
        Reset
      </button>
      <p className="sr-only" aria-live="polite">
        {caption ?? ""}
      </p>
      {/* The same run as a list, in order, for screen readers (plan revision 3.4, B5). */}
      <ol className="sr-only">
        {graph.tiles.map((t) => (
          <li key={t.id}>
            {t.label}: {FLOW_STATE_LABEL[t.state]}
            {t.meta ? `, ${t.meta}` : ""}
            {t.caption ? `, ${t.caption}` : ""}
          </li>
        ))}
      </ol>
    </div>
  );
}
