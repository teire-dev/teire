import { TILE_OF_STEP } from "./model";

/**
 * One clock for a run (plan revision 3.4, B5): where the run was at time `t` on its own timeline, from
 * its ordered events. The timeline's playhead, the canvas and the inspector all read this, so a replay
 * moves them together. `t` is milliseconds from when work began (the trace's origin); `null` means now.
 */
export interface RunMoment {
  /** The step the run was on at `t`, or null before its first step. */
  step: string | null;
  /** Whether `t` falls before the run's end (the canvas shows it live) or at/after it (final state). */
  during: boolean;
}

export function sheetAt(
  events: { at: string; step: string }[],
  began: string | null,
  t: number | null,
  end: number,
): RunMoment | null {
  if (t === null || !began || t >= end) return null;
  const at = Date.parse(began) + t;
  let step: string | null = null;
  for (const e of events) {
    if (Date.parse(e.at) > at) break;
    if (TILE_OF_STEP[e.step]) step = e.step;
  }
  return { step, during: true };
}

/** A run has enough of a record to replay: several distinct steps after it began. */
export function canReplay(events: { step: string }[]) {
  return new Set(events.map((e) => e.step).filter((s) => TILE_OF_STEP[s])).size >= 3;
}
