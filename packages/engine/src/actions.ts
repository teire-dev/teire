/**
 * Actions a person can ask Teire for (plan revision 3.3, "Actions with real results", D121): one typed
 * allow-list shared by the web, which records the request, and the worker, which re-authorizes and
 * acts. Comment commands and Dashboard ticks are recorded with the same kinds (source `comment` /
 * `dashboard`), so a repository's Activity lists everything.
 */
export const ACTION_KINDS = [
  "rescan",
  "pause",
  "resume",
  "set-fix-mode",
  "set-installation-fix-mode",
  "fix",
  "rebase",
  "recreate",
  "ignore",
  "unignore",
  "cancel-run",
  "retry-run",
  "feedback",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type ActionStatus =
  | "requested"
  | "accepted"
  | "started"
  | "stopping"
  | "done"
  | "refused"
  | "failed"
  | "unknown";
export const TERMINAL: ReadonlySet<ActionStatus> = new Set(["done", "refused", "failed"]);

/** Actions on a whole installation rather than one repository (D126: an org admin or the owner). */
export const INSTALLATION_ACTIONS: ReadonlySet<ActionKind> = new Set(["set-installation-fix-mode"]);

/**
 * The action that undoes a done one, when there is one (an undo toast): pause ↔ resume, ignore ↔
 * unignore; a fix mode goes back to what it was (the worker records the previous mode in the result).
 */
export function undoOf(
  kind: ActionKind,
  params: Record<string, unknown>,
  previous?: { mode?: string | null; security?: string },
): { kind: ActionKind; params: Record<string, unknown> } | null {
  switch (kind) {
    case "pause":
      return { kind: "resume", params: {} };
    case "resume":
      return { kind: "pause", params: {} };
    case "ignore":
      return { kind: "unignore", params };
    case "unignore":
      return { kind: "ignore", params };
    case "set-fix-mode":
      return previous && "mode" in previous
        ? { kind: "set-fix-mode", params: { mode: previous.mode ?? null } }
        : null;
    case "set-installation-fix-mode":
      return previous?.mode
        ? {
            kind: "set-installation-fix-mode",
            params: { mode: previous.mode, ...(previous.security ? { security: previous.security } : {}) },
          }
        : null;
    default:
      return null;
  }
}

/** What an action is called in a list or a toast ("Set fix mode to Ask first"). */
export function describeAction(kind: ActionKind, params: Record<string, unknown>) {
  const mode = { auto: "Automatic", ask: "Ask first", off: "Off" } as Record<string, string>;
  switch (kind) {
    case "set-fix-mode":
      return params.mode ? `Set fix mode to ${mode[String(params.mode)]}` : "Use the installation's fix mode";
    case "set-installation-fix-mode":
      return `Set the installation's fix mode to ${mode[String(params.mode)]}`;
    case "fix":
      return `Fix ${params.target}`;
    case "rebase":
    case "recreate":
      return `${kind[0]?.toUpperCase()}${kind.slice(1)} ${params.group}`;
    case "ignore":
    case "unignore":
      return `${kind === "ignore" ? "Ignore" : "Unignore"} ${params.update ? `${params.update} updates of ` : ""}${params.target}`;
    case "cancel-run":
      return "Cancel the run";
    case "retry-run":
      return "Retry the run";
    case "feedback":
      return "Report a wrong finding";
    default:
      return `${kind[0]?.toUpperCase()}${kind.slice(1)}`;
  }
}
