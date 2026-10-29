"use client";

import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  getSmoothStepPath,
} from "@xyflow/react";
import { useReducedMotion } from "motion/react";
import type { FlowState } from "@/lib/flow/model";

/**
 * The one edge every React Flow canvas draws (plan revision 3.4, B2): a line in its state's colour
 * (dashed while pending, skipped or failed), heavier when it carries more, a pill with the figure it
 * carries, and a dot travelling along it while Teire works there. The run canvas uses the step path,
 * onboarding and the estate map the bezier.
 */
export type FlowEdgeData = { state: FlowState; label?: string; weight?: number };
export type FlowEdgeT = Edge<FlowEdgeData, "flow" | "step">;

export const STROKE: Record<FlowState, string> = {
  pending: "var(--ink-3)",
  live: "var(--signal)",
  done: "color-mix(in oklab, var(--ink) 45%, transparent)",
  proven: "var(--proven)",
  not_proven: "var(--attention)",
  failed: "var(--broke)",
  skipped: "var(--rule-strong)",
};

/** The round connection point on a tile, the same on every canvas. */
export const HANDLE_CLASS = "!size-2 !border-[1.5px] !border-rule-strong !bg-sheet";

function Drawn({
  id,
  path,
  labelX,
  labelY,
  data,
  dur,
}: {
  id: string;
  path: string;
  labelX: number;
  labelY: number;
  data: FlowEdgeData | undefined;
  dur: string;
}) {
  const reduce = useReducedMotion();
  const state = data?.state ?? "pending";
  const dashed = state === "pending" || state === "failed" || state === "skipped";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: STROKE[state],
          strokeWidth: 1.5 + Math.min(data?.weight ?? 0, 4) * 0.45,
          strokeDasharray: dashed ? "5 5" : undefined,
          opacity: state === "pending" ? 0.55 : 1,
        }}
      />
      {state === "live" && !reduce ? (
        <circle r={4.5} fill="var(--signal)" stroke="var(--signal-soft)" strokeWidth={3}>
          <animateMotion dur={dur} repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
      {data?.label ? (
        <EdgeLabelRenderer>
          <span
            className="nodrag nopan pointer-events-none absolute rounded-full bg-sheet px-1.5 py-px font-mono text-[10px] text-ink-2 shadow-tile"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export function BezierEdge(props: EdgeProps<FlowEdgeT>) {
  const [path, labelX, labelY] = getBezierPath(props);
  return <Drawn id={props.id} path={path} labelX={labelX} labelY={labelY} data={props.data} dur="1.3s" />;
}

export function StepEdge(props: EdgeProps<FlowEdgeT>) {
  const [path, labelX, labelY] = getSmoothStepPath({ ...props, borderRadius: 14 });
  return <Drawn id={props.id} path={path} labelX={labelX} labelY={labelY} data={props.data} dur="1.2s" />;
}

/** Module-level, so React Flow never sees a new type map and remounts (plan 3.4, A4). */
export const EDGE_TYPES = { flow: BezierEdge, step: StepEdge };
