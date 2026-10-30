import { z } from "zod";
import type { ActionKind } from "./actions";
import { CONFIG_PR_KEYS, type ConfigPrKey } from "./config/keys";

/**
 * Each action's parameters, exactly (the web validates before recording, the worker again before
 * acting). Kept apart from `actions.ts` so a page's bundle gets the labels without zod.
 */
const target = z.string().trim().min(1).max(300);
const runId = z.string().uuid();
const fixMode = z.enum(["auto", "ask", "off"]);
const registryEcosystem = z.enum(["npm", "pypi", "cargo", "rubygems", "maven", "go"]);
/** A registry host, lower case, no scheme, port or path (`npm.pkg.github.com`). */
const registryHost = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/);

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
  /** An open Teire PR re-verified on the current base (the daily refresh, asked now). */
  refresh: z.object({ group: target }),
  recreate: z.object({ group: target }),
  ignore: z.object({ target, update: z.enum(["major", "minor", "patch"]).optional() }),
  unignore: z.object({ target, update: z.enum(["major", "minor", "patch"]).optional() }),
  "cancel-run": z.object({ runId }),
  "retry-run": z.object({ runId }),
  /** Both sides checked again on the PR's final files (U2). */
  "reverify-run": z.object({ runId }),
  /** A draft PR from a run that ended in an issue, titled unconfirmed (U2). */
  "open-draft-anyway": z.object({ runId }),
  /** One `teire.yml` setting changed through a pull request (U3). */
  "config-pr": z.object({
    key: z.enum(Object.keys(CONFIG_PR_KEYS) as [ConfigPrKey, ...ConfigPrKey[]]),
    value: z.string().trim().max(12_000),
  }),
  /** Teire's starter `teire.yml` (every key at its default) through a pull request (U3). */
  "starter-config-pr": z.object({}),
  /** One Fix now per repository a change reaches (U3), each authorized there, with a receipt per repository. */
  "fix-in-all": z.object({
    changeId: z.string().trim().min(1).max(300),
    title: z.string().max(300).optional(),
    repos: z
      .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
      .min(1)
      .max(100),
  }),
  /**
   * Turn Teire on for a repository from the welcome flow (plan revision 3.3, U5, R-P32): active first,
   * then the onboarding PR is closed with a comment, unless the person keeps it.
   */
  activate: z.object({ keep: z.boolean().default(false) }),
  feedback: z.object({
    reason: z.string().trim().min(1).max(2000),
    groupKey: z.string().max(300).optional(),
  }),
  /** Teire uninstalled from an account (the person types the account's login to confirm). */
  uninstall: z.object({ account: target }),
  /**
   * A private registry's credential (S18.7): the secret arrives sealed for the worker
   * (`@teire/engine/credentials`), which checks the person is an admin and the host is public.
   */
  "set-registry-credential": z.object({
    ecosystem: registryEcosystem,
    host: registryHost,
    url: z.string().url().max(500).nullable(),
    kind: z.enum(["token", "basic"]),
    username: z.string().trim().max(200).nullable(),
    sealed: z
      .string()
      .regex(/^v1\.[\w-]+\.[\w-]+\.[\w-]+\.[\w-]*$/)
      .max(8000),
  }),
  "remove-registry-credential": z.object({ ecosystem: registryEcosystem, host: registryHost }),
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
