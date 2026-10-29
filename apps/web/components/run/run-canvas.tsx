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
import { useTheme } from "fumadocs-ui/provider/base";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { EDGE_TYPES, type FlowEdgeT, HANDLE_CLASS } from "@/components/flow/flow-edge";
import { TileLabel, TileSquare } from "@/components/flow/tile";
import { FLOW_STATE_LABEL, type FlowGraph, type FlowTile } from "@/lib/flow/model";
import { cn } from "@/lib/utils";

/**
 * The run as a canvas (plan revision 3.4, V3; n8n's execution view): the run's tiles on React Flow,
 * draggable (positions kept per run in this browser, with Reset), a dot travelling into the live
 * tile, and a click (or Enter) on a tile opening its evidence in the inspector. The poll changes only
 * the tiles' data: ids and positions stay, so nothing remounts or jumps. The page never scrolls into a
 * zoom: wheel scrolling passes through, pinch and the controls zoom.
 */
type TileData = { tile: FlowTile; selected: boolean; onSelect: (id: string) => void };
type TileNodeT = Node<TileData, "tile">;

const GAP = 132;
const SIZE = 64;

function TileNode({ id, data }: NodeProps<TileNodeT>) {
  const { tile, selected, onSelect } = data;
  return (
    <div className="relative" style={{ width: SIZE, height: SIZE }}>
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} isConnectable={false} />
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
      <Handle type="source" position={Position.Right} className={HANDLE_CLASS} isConnectable={false} />
      <TileLabel
        tile={tile}
        className="pointer-events-none absolute top-[calc(100%+10px)] left-1/2 w-36 -translate-x-1/2"
      />
    </div>
  );
}

// Module-level, so React Flow never sees a new type map and remounts the nodes (plan 3.4, A4).
const nodeTypes = { tile: TileNode };

const storeKey = (runId: string) => `teire:run-canvas:${runId}`;
function savedPositions(runId: string): Record<string, { x: number; y: number }> {
  try {
    return JSON.parse(localStorage.getItem(storeKey(runId)) ?? "{}");
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
  // React Flow puts its own `light`/`dark` class on the canvas; it must match the app's theme or the
  // `.light` token pin would keep light ink on a dark page.
  const { resolvedTheme } = useTheme();

  // Positions this person dragged to, kept for this run in this browser.
  useEffect(() => {
    const saved = savedPositions(runId);
    if (Object.keys(saved).length)
      setNodes((ns) =>
        ns.map((n) => (saved[n.id] ? { ...n, position: saved[n.id] as { x: number; y: number } } : n)),
      );
  }, [runId, setNodes]);

  // The poll: merge each tile's new data by id, keep where it sits.
  useEffect(() => {
    const byId = new Map(graph.tiles.map((t) => [t.id, t]));
    setNodes((ns) =>
      ns.map((n) => {
        const tile = byId.get(n.id);
        return tile ? { ...n, data: { tile, selected: n.id === selected, onSelect } } : n;
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
      const saved = savedPositions(runId);
      saved[node.id] = node.position;
      try {
        localStorage.setItem(storeKey(runId), JSON.stringify(saved));
      } catch {}
    },
    [runId],
  );
  const reset = () => {
    try {
      localStorage.removeItem(storeKey(runId));
    } catch {}
    setNodes((ns) => ns.map((n, i) => ({ ...n, position: { x: i * GAP, y: 0 } })));
  };

  return (
    <div className={cn("relative h-[260px] w-full", className)}>
      <ReactFlow
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
        fitViewOptions={{ padding: { top: 0.32, bottom: 0.62, left: 0.08, right: 0.08 }, maxZoom: 1.15 }}
        minZoom={0.4}
        maxZoom={1.6}
        aria-label="The run, tile by tile"
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
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
