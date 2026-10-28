import { z } from "zod";
import type { ActionKind } from "./actions";

/**
 * Each action's parameters, exactly (the web validates before recording, the worker again before
 * acting). Kept apart from `actions.ts` so a page's bundle gets the labels without zod.
 */
const target = z.string().trim().min(1).max(300);
const runId = z.string().uuid();
const fixMode = z.enum(["auto", "ask", "off"]);

export const ACTION_PARAMS: Record<ActionKind, z.ZodObject> = {
  rescan: z.object({}),
  pause: z.object({}),
  resume: z.object({}),
  /** A repository's own fix mode; null goes back to the installation's default. */
  "set-fix-mode": z.object({ mode: fixMode.nullable() }),
  /** The installation's default (and its security setting): an org admin or the account owner. */
  "set-installation-fix-mode": z.object({ mode: fixMode, security: z.enum(["auto", "ask"]).optional() }),
  /** A finding (change id, package, provider:name, group key) or an upgrade from "Upgrades available". */
  fix: z.object({ target }),
  rebase: z.object({ group: target }),
  recreate: z.object({ group: target }),
  ignore: z.object({ target, update: z.enum(["major", "minor", "patch"]).optional() }),
  unignore: z.object({ target, update: z.enum(["major", "minor", "patch"]).optional() }),
  "cancel-run": z.object({ runId }),
  "retry-run": z.object({ runId }),
  feedback: z.object({
    reason: z.string().trim().min(1).max(2000),
    groupKey: z.string().max(300).optional(),
  }),
} as const;

export type ActionParams<K extends ActionKind> = z.infer<(typeof ACTION_PARAMS)[K]>;

/** Validates a request against the allow-list: the kind exists and its params have exactly its shape. */
export function parseAction(kind: string, params: unknown) {
  if (!(kind in ACTION_PARAMS)) return { ok: false as const, error: `unknown action ${kind}` };
  const parsed = ACTION_PARAMS[kind as ActionKind].strict().safeParse(params ?? {});
  return parsed.success
    ? { ok: true as const, kind: kind as ActionKind, params: parsed.data as Record<string, unknown> }
    : { ok: false as const, error: parsed.error.issues.map((i) => i.message).join("; ") };
}
