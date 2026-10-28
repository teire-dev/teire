import { posix } from "node:path";
import type { Ecosystem } from "../contract";
import { sameDependency } from "./job";

/**
 * What a `dependabot update` run said (plan D101): one JSON object per line on stdout,
 * `{ type, data }`, the same calls the updater makes to GitHub's API. Decisions come from these
 * events, never from the exit code, which is 1 whenever any error event was recorded.
 */
export interface DependabotDependency {
  name: string;
  version: string | null;
  "previous-version"?: string;
  requirements?: { file: string; requirement: string | null; groups?: unknown[] }[];
  "previous-requirements"?: { file: string; requirement: string | null }[];
  removed?: boolean;
  directory?: string;
}

export interface DependabotFile {
  name: string;
  directory: string;
  content: string;
  content_encoding: string;
  deleted: boolean;
  operation: string;
  support_file: boolean;
  symlink_target?: string;
  mode?: string;
  type?: string;
}

export type ResolverEvent =
  | { type: "create_pull_request" | "update_pull_request"; data: PullRequestData }
  | { type: "close_pull_request"; data: { "dependency-names": string[]; reason: string } }
  | { type: "record_update_job_error" | "record_update_job_unknown_error"; data: JobError }
  | {
      type: "record_update_job_warning";
      data: { "warn-type": string; "warn-title": string; "warn-description"?: string };
    }
  | { type: "mark_as_processed"; data: { "base-commit-sha": string } }
  | {
      type: "update_dependency_list";
      data: { dependencies: DependabotDependency[]; dependency_files: string[] };
    }
  | { type: string; data: unknown };

interface PullRequestData {
  "base-commit-sha": string;
  dependencies?: DependabotDependency[];
  "dependency-names"?: string[];
  "updated-dependency-files": DependabotFile[];
  "pr-title"?: string;
  "pr-body"?: string;
  "commit-message"?: string;
  "dependency-group"?: Record<string, unknown> | null;
}

interface JobError {
  "error-type": string;
  "error-details"?: Record<string, unknown> | null;
}

/** Every `{type, data}` line; anything else on stdout is ignored (the CLI's logs go to stderr). */
export function parseEvents(stdout: string): ResolverEvent[] {
  const out: ResolverEvent[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const value = JSON.parse(text) as { type?: unknown; data?: unknown };
      if (typeof value.type === "string") out.push({ type: value.type, data: value.data } as ResolverEvent);
    } catch {
      // A partial line (a killed run) is not an event.
    }
  }
  return out;
}

/** A file change as Teire commits it (the shape `commitToBranch` takes, D-50). */
export interface ResolvedFile {
  path: string;
  /** Null deletes the file. A symlink's target when `mode` is 120000. */
  content: string | null;
  encoding?: "base64";
  mode?: "100644" | "100755" | "120000";
}

export class UnsafePathError extends Error {}

/**
 * A changed file's repo-relative path, refused when it would leave the checkout (R-P24): an
 * updater result is data from a process that ran the repo's own build files.
 */
export function guardedPath(directory: string, name: string) {
  // Refused, not clamped: normalising "/../../etc/x" would quietly yield the in-repo "etc/x".
  const raw = `${directory || "/"}/${name}`;
  if (raw.includes("\0") || raw.split(/[\\/]/).includes(".."))
    throw new UnsafePathError(`refused path ${raw}`);
  const joined = posix.normalize(posix.join("/", directory || "/", name));
  if (!joined.startsWith("/") || joined.split("/").includes("..") || joined === "/")
    throw new UnsafePathError(`refused path ${directory}/${name}`);
  const path = joined.slice(1);
  if (!path || path.startsWith(".git/") || path === ".git") throw new UnsafePathError(`refused path ${path}`);
  return path;
}

function fileOf(f: DependabotFile): ResolvedFile {
  const path = guardedPath(f.directory, f.name);
  if (f.deleted || f.operation === "delete") return { path, content: null };
  if (f.mode === "120000" || f.symlink_target)
    return { path, content: f.symlink_target ?? f.content, mode: "120000" };
  const mode = f.mode === "100755" ? ("100755" as const) : undefined;
  return f.content_encoding === "base64"
    ? { path, content: f.content, encoding: "base64", ...(mode ? { mode } : {}) }
    : { path, content: f.content, ...(mode ? { mode } : {}) };
}

/** Why a job produced no change, in words a PR or issue can quote (R-M6, D-48). */
const STOPS: Record<string, string> = {
  dependency_file_not_resolvable: "the dependency files could not be resolved at this version",
  update_not_possible: "no set of versions satisfies every requirement with this upgrade",
  security_update_not_possible: "no version that fixes the advisory satisfies the other requirements",
  security_update_not_needed: "the installed version is not affected by the advisory",
  security_update_not_found: "no version that fixes the advisory has been published",
  security_update_dependency_not_found: "the vulnerable dependency is not in the dependency files",
  all_versions_ignored: "every newer version is ignored by the repository's configuration",
  pull_request_exists_for_latest_version: "a pull request for this version already exists",
  pull_request_exists_for_security_update: "a pull request for this security update already exists",
  tool_version_not_supported: "the repository asks for a tool version the updater does not support",
  dependency_file_not_found: "a dependency file the job needs was not found",
  dependency_file_not_parseable: "a dependency file could not be parsed",
  dependency_file_not_evaluatable: "a dependency file runs code the updater would not run",
  git_dependencies_not_reachable: "a git dependency could not be reached",
  path_dependencies_not_reachable: "a path dependency is outside the repository",
  private_source_timed_out: "a package registry did not answer in time",
  private_source_authentication_failure: "a private registry refused the credentials",
  private_source_certificate_failure: "a registry's certificate was not trusted",
  go_module_path_mismatch: "a Go module's path does not match where it is fetched from",
  illformed_requirement: "a requirement in the dependency files is not valid",
  misconfigured_tooling: "the repository's tool configuration stopped the update",
};

export function stopMessage(type: string, details?: Record<string, unknown> | null) {
  const base = STOPS[type] ?? `the updater stopped (${type})`;
  const detail = details
    ? Object.entries(details)
        .filter(([, v]) => typeof v === "string" || typeof v === "number")
        .map(([k, v]) => `${k}: ${String(v).slice(0, 300)}`)
        .join("; ")
    : "";
  return detail ? `${base} (${detail})` : base;
}

export interface MovedDependency {
  name: string;
  from: string | null;
  to: string | null;
  removed: boolean;
  directory: string | null;
}

export type ResolverResult =
  | {
      kind: "change";
      /** `create_pull_request` for a new PR, `update_pull_request` for a refresh. */
      event: "create_pull_request" | "update_pull_request";
      files: ResolvedFile[];
      /** Every package the updater moved, the lead and its co-upgrades (D-10). */
      moved: MovedDependency[];
      /** The version the lead dependency landed on; below T means "resolvable only up to here" (D103). */
      leadVersion: string | null;
      title: string | null;
      body: string | null;
      commitMessage: string | null;
      warnings: string[];
    }
  | { kind: "close"; reason: string; dependencies: string[] }
  | { kind: "stop"; type: string; message: string; warnings: string[] }
  | { kind: "nothing"; warnings: string[] };

/**
 * One result from a job's events. A change wins (the updater may also record warnings); then a
 * close; then the first error, quoted; and a job that reached `mark_as_processed` with none of
 * those found nothing to do.
 */
export function resultOf(
  events: ResolverEvent[],
  lead: { ecosystem: Ecosystem; name: string },
): ResolverResult {
  const warnings = events
    .filter((e) => e.type === "record_update_job_warning")
    .map((e) => {
      const d = e.data as { "warn-title"?: string; "warn-description"?: string };
      return [d["warn-title"], d["warn-description"]].filter(Boolean).join(": ");
    });
  const pr = events.find((e) => e.type === "create_pull_request" || e.type === "update_pull_request") as
    | { type: "create_pull_request" | "update_pull_request"; data: PullRequestData }
    | undefined;
  if (pr) {
    const deps = pr.data.dependencies ?? [];
    const moved = deps.map((d) => ({
      name: d.name,
      from: d["previous-version"] ?? null,
      to: d.version ?? null,
      removed: !!d.removed,
      directory: d.directory ?? null,
    }));
    return {
      kind: "change",
      event: pr.type,
      files: pr.data["updated-dependency-files"].map(fileOf),
      moved,
      leadVersion: moved.find((m) => sameDependency(lead.ecosystem, lead.name, m.name))?.to ?? null,
      title: pr.data["pr-title"] ?? null,
      body: pr.data["pr-body"] ?? null,
      commitMessage: pr.data["commit-message"] ?? null,
      warnings,
    };
  }
  const close = events.find((e) => e.type === "close_pull_request");
  if (close) {
    const d = close.data as { "dependency-names": string[]; reason: string };
    return { kind: "close", reason: d.reason, dependencies: d["dependency-names"] ?? [] };
  }
  const error = events.find(
    (e) => e.type === "record_update_job_error" || e.type === "record_update_job_unknown_error",
  );
  if (error) {
    const d = error.data as JobError;
    return {
      kind: "stop",
      type: d["error-type"],
      message: stopMessage(d["error-type"], d["error-details"]),
      warnings,
    };
  }
  return { kind: "nothing", warnings };
}
