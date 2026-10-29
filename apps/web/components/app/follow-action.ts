"use client";

import { type ActionStatus, TERMINAL } from "@teire/engine/actions";
import { type ActionState, act } from "@/app/(app)/app/actions";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask for an action and follow it to the worker's answer without a toast (the welcome flow shows each
 * repository's result in place). Every second, every three after a minute, for up to ten minutes.
 */
export async function followAction(
  request: {
    kind: string;
    params: Record<string, unknown>;
    repo?: string;
    installationId?: number;
    key: string;
  },
  onUpdate: (state: ActionState | { error: string }) => void,
): Promise<ActionState | { error: string }> {
  const first = await act(request).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : "Teire couldn't be reached",
  }));
  onUpdate(first);
  if ("error" in first) return first;
  let state = first;
  const began = Date.now();
  while (!TERMINAL.has(state.status as ActionStatus) && Date.now() - began < 10 * 60_000) {
    await sleep(Date.now() - began > 60_000 ? 3000 : 1000);
    const res = await fetch(`/api/actions/${state.id}`, { cache: "no-store" }).catch(() => null);
    if (res?.ok) {
      state = (await res.json()) as ActionState;
      onUpdate(state);
    }
  }
  return state;
}
