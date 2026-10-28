import YAML from "yaml";
import type { TeireConfig } from "../config";
import type { RepoTree } from "../inventory/tree";
import { dependabotDirectory, type IgnoreCondition, type JobInput, type TeireManager } from "./job";

/**
 * A repo's `.github/dependabot.yml`, honoured (plan D97, S14.2): its ignores, groups and update
 * settings shape the resolver's jobs, `teire.yml` wins where both set something, and every setting
 * Teire doesn't apply is reported, never silently dropped. Keys follow GitHub's dependabot.yml
 * reference; the semantics are dependabot-core's (`updater/lib/dependabot/job.rb`).
 */
export interface DependabotUpdate {
  ecosystem: string;
  directories: string[];
  ignore: IgnoreCondition[];
  allow: { dependencyName?: string; dependencyType?: string }[];
  groups: { name: string; appliesTo?: string; rules: Record<string, unknown> }[];
  versioningStrategy?: string;
  vendor?: boolean;
  excludePaths?: string[];
  commitMessage?: { prefix?: string; prefixDevelopment?: string; includeScope?: boolean };
  labels?: string[];
  openPullRequestsLimit?: number;
  targetBranch?: string;
  cooldown?: Record<string, unknown>;
  interval?: string;
  insecureExternalCode?: "allow" | "deny";
  registries?: string[] | "*";
}

export interface DependabotConfig {
  path: string | null;
  updates: DependabotUpdate[];
  problems: string[];
}

/** dependabot.yml's `package-ecosystem` for each of Teire's managers. */
export const DEPENDABOT_ECOSYSTEM: Record<TeireManager, string> = {
  npm: "npm",
  yarn: "npm",
  pnpm: "npm",
  bun: "bun",
  pip: "pip",
  "pip-compile": "pip",
  pipenv: "pip",
  poetry: "pip",
  uv: "uv",
  go: "gomod",
  cargo: "cargo",
  bundler: "bundler",
  maven: "maven",
  gradle: "gradle",
};

/** Keys Teire reads; anything else in an `updates` entry is reported as not applied. */
const KNOWN = new Set([
  "package-ecosystem",
  "directory",
  "directories",
  "schedule",
  "ignore",
  "allow",
  "groups",
  "versioning-strategy",
  "vendor",
  "exclude-paths",
  "commit-message",
  "labels",
  "open-pull-requests-limit",
  "target-branch",
  "cooldown",
  "insecure-external-code-execution",
  "registries",
  "rebase-strategy",
  "assignees",
  "reviewers",
  "milestone",
  "pull-request-branch-name",
]);

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function readDependabotConfig(tree: RepoTree): DependabotConfig {
  const path =
    [".github/dependabot.yml", ".github/dependabot.yaml"].find((p) => tree.read(p) !== null) ?? null;
  if (!path) return { path: null, updates: [], problems: [] };
  const problems: string[] = [];
  let doc: { updates?: unknown; "multi-ecosystem-groups"?: unknown };
  try {
    doc = (YAML.parse(tree.read(path) ?? "") ?? {}) as typeof doc;
  } catch (error) {
    return {
      path,
      updates: [],
      problems: [`${path} is not valid YAML: ${(error as Error).message.split("\n")[0]}`],
    };
  }
  if (doc["multi-ecosystem-groups"])
    problems.push(
      `${path}: multi-ecosystem-groups are not combined; Teire opens one pull request per package (rule 9)`,
    );
  const updates: DependabotUpdate[] = [];
  for (const raw of Array.isArray(doc.updates) ? doc.updates : []) {
    const u = raw as Record<string, unknown>;
    const ecosystem = typeof u["package-ecosystem"] === "string" ? u["package-ecosystem"] : null;
    if (!ecosystem) continue;
    for (const key of Object.keys(u))
      if (!KNOWN.has(key)) problems.push(`${path}: \`${key}\` (${ecosystem}) is not applied by Teire`);
    for (const key of ["assignees", "reviewers", "milestone", "pull-request-branch-name"])
      if (u[key] !== undefined)
        problems.push(`${path}: \`${key}\` (${ecosystem}) is not applied by Teire yet`);
    const commit = (u["commit-message"] ?? null) as Record<string, unknown> | null;
    const schedule = (u.schedule ?? null) as Record<string, unknown> | null;
    updates.push({
      ecosystem,
      directories: typeof u.directory === "string" ? [u.directory] : strings(u.directories),
      ignore: (Array.isArray(u.ignore) ? u.ignore : []).flatMap((i: Record<string, unknown>) => {
        const name = typeof i["dependency-name"] === "string" ? i["dependency-name"] : null;
        if (!name) return [];
        const versions = strings(i.versions);
        const updateTypes = strings(i["update-types"]);
        // Each version range is its own condition, as the updater reads them.
        return versions.length
          ? versions.map((v) => ({
              dependencyName: name,
              versionRequirement: v,
              ...(updateTypes.length ? { updateTypes } : {}),
            }))
          : [{ dependencyName: name, ...(updateTypes.length ? { updateTypes } : {}) }];
      }),
      allow: (Array.isArray(u.allow) ? u.allow : []).map((a: Record<string, unknown>) => ({
        ...(typeof a["dependency-name"] === "string" ? { dependencyName: a["dependency-name"] } : {}),
        ...(typeof a["dependency-type"] === "string" ? { dependencyType: a["dependency-type"] } : {}),
      })),
      groups: Object.entries((u.groups ?? {}) as Record<string, Record<string, unknown>>).map(([name, g]) => {
        const { "applies-to": appliesTo, ...rules } = g ?? {};
        return { name, ...(typeof appliesTo === "string" ? { appliesTo } : {}), rules };
      }),
      ...(typeof u["versioning-strategy"] === "string"
        ? { versioningStrategy: u["versioning-strategy"] }
        : {}),
      ...(typeof u.vendor === "boolean" ? { vendor: u.vendor } : {}),
      ...(strings(u["exclude-paths"]).length ? { excludePaths: strings(u["exclude-paths"]) } : {}),
      ...(commit
        ? {
            commitMessage: {
              ...(typeof commit.prefix === "string" ? { prefix: commit.prefix } : {}),
              ...(typeof commit["prefix-development"] === "string"
                ? { prefixDevelopment: commit["prefix-development"] }
                : {}),
              ...(commit.include === "scope" ? { includeScope: true } : {}),
            },
          }
        : {}),
      ...(Array.isArray(u.labels) ? { labels: strings(u.labels) } : {}),
      ...(typeof u["open-pull-requests-limit"] === "number"
        ? { openPullRequestsLimit: u["open-pull-requests-limit"] }
        : {}),
      ...(typeof u["target-branch"] === "string" ? { targetBranch: u["target-branch"] } : {}),
      ...(u.cooldown && typeof u.cooldown === "object"
        ? { cooldown: u.cooldown as Record<string, unknown> }
        : {}),
      ...(typeof schedule?.interval === "string" ? { interval: schedule.interval } : {}),
      ...(u["insecure-external-code-execution"] === "allow" ||
      u["insecure-external-code-execution"] === "deny"
        ? { insecureExternalCode: u["insecure-external-code-execution"] }
        : {}),
      ...(u.registries === "*"
        ? { registries: "*" as const }
        : strings(u.registries).length
          ? { registries: strings(u.registries) }
          : {}),
    });
  }
  return { path, updates, problems };
}

/** `*` within a path segment, `**` across segments, as dependabot.yml `directories` globs read. */
function globMatches(pattern: string, dir: string) {
  const re = pattern
    .replace(/\/+$/, "")
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${re || "/"}$`).test(dir);
}

const ECOSYSTEM_PREFIX = /^(npm|pypi|go|cargo|rubygems|maven)[:/]/;

/**
 * A `teire.yml` / `@teire ignore` target as an ignore condition: a package (`lodash`,
 * `npm:lodash`, `@scope/name`, the lineage `go/github.com/x/y/v4`) ignores every update; a group
 * key (`npm/zod/4.6.7`) ignores that version. Change ids (`…/1.0..2.0/symbol-removed`) and
 * `provider:` targets concern findings, not versions: null.
 */
export function teireIgnore(target: string): IgnoreCondition | null {
  const t = target.trim();
  if (!t || t.startsWith("provider:") || t.includes("..")) return null;
  const rest = t.replace(ECOSYSTEM_PREFIX, "");
  const segments = rest.split("/");
  const last = segments.at(-1) ?? "";
  // A target is a version (`4.6.7`, `v5.3.1`); a Go major suffix (`v4`) is part of the module path.
  if (segments.length > 1 && /^v?\d+\.\d+/.test(last) && !(rest.startsWith("@") && segments.length === 2))
    return {
      dependencyName: segments.slice(0, -1).join("/"),
      versionRequirement: `= ${last.replace(/^v(?=\d)/, "")}`,
    };
  return { dependencyName: rest };
}

/** The `updates` entry for this manager and lockfile root, if the repo has one. */
export function updateFor(config: DependabotConfig, manager: TeireManager, root: string) {
  const dir = dependabotDirectory(root);
  const ecosystem = DEPENDABOT_ECOSYSTEM[manager];
  return (
    config.updates.find(
      (u) =>
        (u.ecosystem === ecosystem || (ecosystem === "uv" && u.ecosystem === "pip")) &&
        u.directories.some((d) => globMatches(d === "/" ? "/" : d, dir)),
    ) ?? null
  );
}

/**
 * Job options for one dependency from the repo's settings. `teire.yml` wins where both set the same
 * thing; each such conflict is reported once, so the Dashboard can say which file decided.
 */
export function jobSettings(
  update: DependabotUpdate | null,
  teire: Pick<TeireConfig, "present" | "ignore" | "pullRequests" | "schedule">,
): { options: Partial<JobInput>; conflicts: string[] } {
  const conflicts: string[] = [];
  // Teire's own ignores, as the updater reads them, so it never co-moves something the repo ignores.
  const teireIgnores = teire.ignore.flatMap((t) => {
    const c = teireIgnore(t);
    return c ? [c] : [];
  });
  const options: Partial<JobInput> = {
    ignore: [...(update?.ignore ?? []), ...teireIgnores],
    ...(update?.groups.length ? { groups: update.groups } : {}),
    ...(update?.versioningStrategy ? { versioningStrategy: update.versioningStrategy } : {}),
    ...(update?.vendor ? { vendor: true } : {}),
    ...(update?.excludePaths ? { excludePaths: update.excludePaths } : {}),
    ...(update?.insecureExternalCode === "allow" ? { allowExternalCode: true } : {}),
  };
  if (update?.commitMessage) {
    const teirePrefix = teire.present ? teire.pullRequests.commitMessage.prefix : "";
    if (teirePrefix && update.commitMessage.prefix && teirePrefix !== update.commitMessage.prefix)
      conflicts.push(
        `commit-message prefix: teire.yml's "${teirePrefix}" is used, not dependabot.yml's "${update.commitMessage.prefix}"`,
      );
    options.commitMessage = teirePrefix
      ? { ...update.commitMessage, prefix: teirePrefix }
      : update.commitMessage;
  }
  if (update && teire.present) {
    if (
      update.targetBranch &&
      teire.pullRequests.targetBranch &&
      update.targetBranch !== teire.pullRequests.targetBranch
    )
      conflicts.push(
        `target-branch: teire.yml's ${teire.pullRequests.targetBranch} is used, not ${update.targetBranch}`,
      );
    if (
      update.openPullRequestsLimit !== undefined &&
      update.openPullRequestsLimit !== teire.pullRequests.limit
    )
      conflicts.push(
        `open pull requests: teire.yml's limit of ${teire.pullRequests.limit} is used, not dependabot.yml's ${update.openPullRequestsLimit}`,
      );
  }
  return { options, conflicts };
}
