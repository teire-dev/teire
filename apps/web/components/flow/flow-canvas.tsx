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
import { GripVertical } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useMemo } from "react";
import { EDGE_TYPES, type FlowEdgeT, HANDLE_CLASS } from "@/components/flow/flow-edge";
import { TileLabel, type TileSize, TileSquare } from "@/components/flow/tile";
import { useCanvasMode } from "@/components/flow/use-canvas-mode";
import type { FlowLink, FlowTile } from "@/lib/flow/model";
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

const PX = { lg: 80, md: 64, sm: 44 } as const;

function TileNode({ data }: NodeProps<TileNodeT>) {
  const { tile } = data;
  const px = PX[tile.size ?? "md"];
  return (
    <div
      className={cn("relative", tile.draggable && "cursor-grab active:cursor-grabbing")}
      style={{ width: px, height: px }}
    >
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} isConnectable={false} />
      <TileSquare
        tile={tile}
        size={tile.size ?? "md"}
        className={cn(tile.draggable && "ring-2 ring-signal ring-offset-2 ring-offset-canvas")}
      />
      {tile.draggable ? (
        <span
          aria-hidden
          className="absolute -top-2 -left-2 flex size-5 items-center justify-center rounded-full bg-signal text-white shadow-card dark:text-sheet"
        >
          <GripVertical className="size-3" />
        </span>
      ) : null}
      <Handle type="source" position={Position.Right} className={HANDLE_CLASS} isConnectable={false} />
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

const nodeTypes = { tile: TileNode };

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
  const canvasMode = useCanvasMode();
  const flow = useReactFlow();
  const reduce = useReducedMotion();
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
    // Re-framing glides, unless the person asked for less motion.
    const t = setTimeout(
      () => void flow.fitView({ padding: 0.18, duration: reduce ? 0 : 500, maxZoom: 1.25 }),
      30,
    );
    return () => clearTimeout(t);
  }, [ids, flow, reduce]);
  const edges = useMemo<FlowEdgeT[]>(
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
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, n) => onDrop?.(n.id, n.position)}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        panOnDrag={false}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.25, minZoom: 0.2 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        colorMode={canvasMode}
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
