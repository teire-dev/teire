"use client";

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  type Edge,
  type EdgeProps,
  getBezierPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useTheme } from "fumadocs-ui/provider/base";
import { GripVertical } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useMemo } from "react";
import { TileLabel, type TileSize, TileSquare } from "@/components/flow/tile";
import type { FlowLink, FlowState, FlowTile } from "@/lib/flow/model";
import { cn } from "@/lib/utils";

/**
 * A flow on React Flow for the places people act on it (plan revision 3.4, B2 `explore`): onboarding's
 * growing flow and the estate map. The caller places the tiles (a step's layout, a fan-out); a tile
 * marked `draggable` can be picked up, and `onDrop` hears where it landed (drag-to-choose). Everything
 * else stays put; wheel scrolling passes through to the page.
 */
export interface PlacedTile extends FlowTile {
  x: number;
  y: number;
  size?: TileSize;
  draggable?: boolean;
  /** A dashed "drop here" hint under a draggable tile. */
  hint?: string;
}

type Data = { tile: PlacedTile };
type TileNodeT = Node<Data, "tile">;
type EdgeT = Edge<{ state: FlowState; label?: string }, "flow">;

const PX = { lg: 80, md: 64, sm: 44 } as const;

function TileNode({ data }: NodeProps<TileNodeT>) {
  const { tile } = data;
  const px = PX[tile.size ?? "md"];
  return (
    <div
      className={cn("relative", tile.draggable && "cursor-grab active:cursor-grabbing")}
      style={{ width: px, height: px }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2 !border-[1.5px] !border-rule-strong !bg-sheet"
        isConnectable={false}
      />
      <TileSquare
        tile={tile}
        size={tile.size ?? "md"}
        className={cn(tile.draggable && "ring-2 ring-signal ring-offset-2 ring-offset-canvas")}
      />
      {tile.draggable ? (
        <span
          aria-hidden
          className="absolute -top-2 -left-2 flex size-5 items-center justify-center rounded-full bg-signal text-white shadow-card"
        >
          <GripVertical className="size-3" />
        </span>
      ) : null}
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2 !border-[1.5px] !border-rule-strong !bg-sheet"
        isConnectable={false}
      />
      <TileLabel
        tile={tile}
        size={tile.size ?? "md"}
        className="pointer-events-none absolute top-[calc(100%+8px)] left-1/2 w-36 -translate-x-1/2"
      />
      {tile.hint ? (
        <span className="pointer-events-none absolute top-[calc(100%+52px)] left-1/2 w-44 -translate-x-1/2 text-center text-[11px] text-signal">
          {tile.hint}
        </span>
      ) : null}
    </div>
  );
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

function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<EdgeT>) {
  const reduce = useReducedMotion();
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const state = data?.state ?? "pending";
  const dashed = state === "pending" || state === "failed" || state === "skipped";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: STROKE[state],
          strokeWidth: 1.75,
          strokeDasharray: dashed ? "5 5" : undefined,
          opacity: state === "pending" ? 0.6 : 1,
        }}
      />
      {state === "live" && !reduce ? (
        <circle r={4.5} fill="var(--signal)" stroke="var(--signal-soft)" strokeWidth={3}>
          <animateMotion dur="1.3s" repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
    </>
  );
}

const nodeTypes = { tile: TileNode };
const edgeTypes = { flow: FlowEdge };

const toNodes = (tiles: PlacedTile[]): TileNodeT[] =>
  tiles.map((t) => ({
    id: t.id,
    type: "tile",
    position: { x: t.x, y: t.y },
    width: PX[t.size ?? "md"],
    height: PX[t.size ?? "md"],
    draggable: !!t.draggable,
    data: { tile: t },
  }));

function Canvas({
  tiles,
  links,
  onDrop,
  label,
  className,
}: {
  tiles: PlacedTile[];
  links: FlowLink[];
  onDrop?: (id: string, at: { x: number; y: number }) => void;
  label: string;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const flow = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<TileNodeT>(toNodes(tiles));
  // The caller's layout is the truth: a new step, a new choice or new data re-places the tiles.
  const sig = JSON.stringify(
    tiles.map((t) => [t.id, t.x, t.y, t.state, t.label, t.meta, t.caption, t.draggable]),
  );
  const ids = tiles.map((t) => t.id).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the layout's signature
  useEffect(() => {
    setNodes(toNodes(tiles));
  }, [sig, setNodes]);
  // Re-frame when tiles join or leave (a fan-out growing), smoothly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the set of tiles
  useEffect(() => {
    const t = setTimeout(() => void flow.fitView({ padding: 0.18, duration: 500, maxZoom: 1.25 }), 30);
    return () => clearTimeout(t);
  }, [ids, flow]);
  const edges = useMemo<EdgeT[]>(
    () =>
      links.map((l) => ({
        id: `${l.from}-${l.to}`,
        source: l.from,
        target: l.to,
        type: "flow",
        data: { state: l.state, ...(l.label ? { label: l.label } : {}) },
      })),
    [links],
  );
  return (
    <div className={cn("relative h-full w-full", className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, n) => onDrop?.(n.id, n.position)}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        panOnDrag={false}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.25 }}
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
        aria-label={label}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} />
      </ReactFlow>
      <ol className="sr-only">
        {tiles.map((t) => (
          <li key={t.id}>
            {t.label}
            {t.meta ? `, ${t.meta}` : ""}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function FlowCanvas(props: Parameters<typeof Canvas>[0]) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
