"use client";

import { type ActionKind, type ActionStatus, describeAction, TERMINAL, undoOf } from "@teire/engine/actions";
import { toast } from "sonner";
import { type ActionState, act } from "@/app/(app)/app/actions";

/** How often an open action is read back: every second, then every three after the first minute. */
const FAST_MS = 1000;
const SLOW_MS = 3000;
const SLOW_AFTER_MS = 60_000;
/** Past this the toast hands over to the repository's Activity, where the action keeps its outcome. */
const FOLLOW_MS = 10 * 60_000;

export interface ActionRequest {
  kind: ActionKind;
  params: Record<string, unknown>;
  repo?: string;
  installationId?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The request's key: the same action asked again within ten seconds (a double click, a second tab, a
 * retry) is one action on the server (U1 review); a later click is a new one.
 */
async function keyOf(request: ActionRequest) {
  const text = JSON.stringify([
    request.kind,
    request.params,
    request.repo ?? null,
    request.installationId ?? null,
    Math.floor(Date.now() / 10_000),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `web:${[...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40)}`;
}

/** The toast's line while an action is open: what it is doing now, in the worker's words. */
function openLine(label: string, s: ActionState) {
  if (s.status === "unknown") return `${label}: checking…`;
  if (s.result) return `${label}: ${s.result}`;
  return s.status === "requested" ? `${label}…` : `${label}: ${s.status}…`;
}

/**
 * Asks for an action and follows it to the worker's answer in one toast (plan "Actions with real
 * results"): the request, live status, then the real result: "Rescan finished: 3 changes reach your
 * code", "Refused: fixes are Off here (set in .github/teire.yml)". Undo where the action has one; the
 * run or PR it produced otherwise. The same key is sent if the request is retried, so a double click
 * is one action.
 */
export async function runAction(
  request: ActionRequest,
  options: { key?: string; onSettled?: (state: ActionState) => void } = {},
): Promise<ActionState | null> {
  const label = describeAction(request.kind, request.params);
  const toastId = toast.loading(`${label}…`);
  const first = await act({ ...request, key: options.key ?? (await keyOf(request)) }).catch(
    (error: unknown) => ({ error: error instanceof Error ? error.message : "Teire couldn't be reached" }),
  );
  if ("error" in first) {
    toast.error(first.error, { id: toastId });
    return null;
  }
  let state = first;
  const began = Date.now();
  const linkAction = (s: ActionState) => {
    const link = s.links[0];
    return link?.href
      ? { label: link.label === "Run" ? "Open run" : link.label, onClick: () => location.assign(link.href) }
      : undefined;
  };
  while (!TERMINAL.has(state.status as ActionStatus) && Date.now() - began < FOLLOW_MS) {
    toast.loading(openLine(label, state), { id: toastId, action: linkAction(state) });
    await sleep(Date.now() - began > SLOW_AFTER_MS ? SLOW_MS : FAST_MS);
    // Not while the tab is hidden: the poll resumes when the person looks again.
    while (document.hidden) await sleep(SLOW_MS);
    const res = await fetch(`/api/actions/${state.id}`, { cache: "no-store" }).catch(() => null);
    if (res?.ok) state = (await res.json()) as ActionState;
    // Offline for a moment: say so and keep the last word.
    else toast.loading(`${label}: reconnecting…`, { id: toastId });
  }
  const result = state.result ?? label;
  if (state.status === "done") {
    const undo = undoOf(
      request.kind,
      request.params,
      state.params.previous as { mode?: string | null; security?: string } | undefined,
    );
    toast.success(result, {
      id: toastId,
      duration: 8000,
      action: undo
        ? {
            label: "Undo",
            onClick: () => void runAction({ ...request, kind: undo.kind, params: undo.params }),
          }
        : linkAction(state),
    });
  } else if (state.status === "refused")
    toast.warning(`Refused: ${result}`, { id: toastId, duration: 12_000 });
  else if (state.status === "failed") toast.error(`Failed: ${result}`, { id: toastId, duration: 12_000 });
  else
    toast.info(`${label}: still going. Its outcome shows in the repository's Activity.`, {
      id: toastId,
      duration: 8000,
      action: linkAction(state),
    });
  options.onSettled?.(state);
  return state;
}

/**
 * The same action on several repositories (bulk "Set fix mode…", U1): each is its own action with its
 * own outcome; one toast follows them all and ends with every repository's result.
 */
export async function runActions(requests: ActionRequest[], label: string): Promise<ActionState[]> {
  const toastId = toast.loading(`${label}: ${requests.length} repositories…`);
  const states = await Promise.all(
    requests.map(async (r) => {
      const first = await act({ ...r, key: await keyOf(r) }).catch(() => ({
        error: "Teire couldn't be reached",
      }));
      if ("error" in first) return { repo: r.repo, state: null as ActionState | null, error: first.error };
      let state = first;
      const began = Date.now();
      while (!TERMINAL.has(state.status as ActionStatus) && Date.now() - began < FOLLOW_MS) {
        await sleep(Date.now() - began > SLOW_AFTER_MS ? SLOW_MS : FAST_MS);
        const res = await fetch(`/api/actions/${state.id}`, { cache: "no-store" }).catch(() => null);
        if (res?.ok) state = (await res.json()) as ActionState;
      }
      return { repo: r.repo, state, error: null as string | null };
    }),
  );
  const done = states.filter((s) => s.state?.status === "done").length;
  const lines = states
    .filter((s) => s.state?.status !== "done")
    .map((s) => `${s.repo}: ${s.error ?? `${s.state?.status} · ${s.state?.result ?? ""}`}`);
  const said = `${label}: ${done} of ${requests.length} done`;
  if (lines.length) toast.warning(said, { id: toastId, description: lines.join("\n"), duration: 15_000 });
  else toast.success(said, { id: toastId, duration: 8000 });
  return states.flatMap((s) => (s.state ? [s.state] : []));
}
