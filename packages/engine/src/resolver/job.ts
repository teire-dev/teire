import YAML from "yaml";
import type { Ecosystem } from "../contract";

/**
 * Jobs for dependabot-core's updater, run through the `dependabot` CLI (plan D92, S14.2). Job and
 * event shapes follow the CLI's model (dependabot/cli `internal/model/job.go`, `update.go`) and the
 * updater's parser (dependabot-core `updater/lib/dependabot/pull_request.rb`), both MIT.
 */

/** Teire's package managers, as inventory names them. */
export type TeireManager =
  | "npm"
  | "yarn"
  | "pnpm"
  | "bun"
  | "pip"
  | "pip-compile"
  | "pipenv"
  | "poetry"
  | "uv"
  | "go"
  | "cargo"
  | "bundler"
  | "maven"
  | "gradle";

/** Dependabot's `package-manager` for each of Teire's managers (D-61). */
export const PACKAGE_MANAGER: Record<TeireManager, string> = {
  npm: "npm_and_yarn",
  yarn: "npm_and_yarn",
  pnpm: "npm_and_yarn",
  bun: "bun",
  pip: "pip",
  "pip-compile": "pip",
  pipenv: "pip",
  poetry: "pip",
  uv: "uv",
  go: "go_modules",
  cargo: "cargo",
  bundler: "bundler",
  maven: "maven",
  gradle: "gradle",
};

/** PEP 503 as Dependabot's NameNormaliser applies it: lower case, runs of `-_.` to `-`, no extras. */
export function normalisePypi(name: string) {
  return name
    .toLowerCase()
    .replace(/\[.+\]/, "")
    .replace(/[-_.]+/g, "-");
}

/**
 * A dependency's name as Dependabot spells it, and back (R-P26): Maven is `group:artifact` on both
 * sides, Go a module path, PyPI the normalised name; the rest are the registry's own names.
 */
export function dependabotName(ecosystem: Ecosystem, name: string) {
  return ecosystem === "pypi" ? normalisePypi(name) : name;
}

export function sameDependency(ecosystem: Ecosystem, teire: string, dependabot: string) {
  return dependabotName(ecosystem, teire) === dependabotName(ecosystem, dependabot);
}

/** A lockfile root as Dependabot wants a directory: `/` or `/sub/dir`. */
export function dependabotDirectory(root: string) {
  const clean = root.replace(/^\.\/?/, "").replace(/\/+$/, "");
  return clean ? `/${clean}` : "/";
}

export interface Advisory {
  dependencyName: string;
  affectedVersions: string[];
  patchedVersions: string[];
  unaffectedVersions: string[];
}

export interface IgnoreCondition {
  dependencyName: string;
  versionRequirement?: string;
  updateTypes?: string[];
}

export type JobShape =
  /** Upgrade one dependency to exactly T (D103): allowed to it, ignoring anything above T, no cooldown. */
  | { kind: "version"; dependency: string; target: string }
  /** The lowest version that fixes the advisories (S15.7). */
  | { kind: "security"; dependency: string; advisories: Advisory[] }
  /** Bring an open PR up to date (D114): the dependency at the version the PR has. */
  | { kind: "refresh"; dependency: string; version: string; prNumber?: number }
  /** A configured dependabot.yml group's PR (D94: groups only when configured). */
  | { kind: "group-refresh"; group: string; members: { name: string; version: string }[]; prNumber?: number }
  /** `@teire recreate`: start the PR again from the base branch. */
  | { kind: "recreate"; dependency: string; target: string };

export interface JobInput {
  manager: TeireManager;
  ecosystem: Ecosystem;
  /** `owner/name`. */
  repo: string;
  /** The commit Teire scanned; the job is bound to it and its tarball (D102). */
  commit: string;
  /** Every lockfile root that declares the dependency: one job, one PR (D94, R-P25). */
  roots: string[];
  shape: JobShape;
  /** From teire.yml and dependabot.yml (S14.2): what the repo already ignores. */
  ignore?: IgnoreCondition[];
  /** dependabot.yml groups, for group jobs. */
  groups?: { name: string; appliesTo?: string; rules: Record<string, unknown> }[];
  /** dependabot.yml `versioning-strategy` (Dependabot's `requirements-update-strategy`). */
  versioningStrategy?: string;
  vendor?: boolean;
  excludePaths?: string[];
  commitMessage?: { prefix?: string; prefixDevelopment?: string; includeScope?: boolean };
  /**
   * D105: external code (setup.py, gemspec evaluation) is refused only when the job carries
   * private-registry credentials and the repo didn't set `insecure-external-code-execution: allow`.
   * Refusing it otherwise makes Dependabot's pip parser fail every job (D-F1).
   */
  privateCredentials?: boolean;
  /**
   * Files written over the checkout before the updater runs (Teire's pre-steps, D104): the Cargo
   * manifest with removed features dropped. Sent beside the job, never in it (the CLI's decoder
   * rejects unknown keys).
   */
  overlay?: { path: string; content: string }[];
  allowExternalCode?: boolean;
  repoPrivate?: boolean;
  /**
   * Private-registry credentials for dependabot-core's proxy (S18.7), sent beside the job, never in
   * it: the CLI hands them to the proxy, which adds them to the updater's requests; the updater
   * itself sees only which hosts have one.
   */
  credentials?: DependabotCredential[];
}

/** One entry of the CLI's top-level `credentials` (dependabot-core's credential types). */
export type DependabotCredential = Record<string, string | boolean>;

/** Saved registry credentials as dependabot-core's proxy takes them (S18.7). */
export function dependabotCredentials(
  registries: {
    ecosystem: string;
    url: string;
    host: string;
    scope?: string;
    secret?: { kind: "token" | "basic"; username: string | null; value: string };
  }[],
): DependabotCredential[] {
  return registries.flatMap((r): DependabotCredential[] => {
    const s = r.secret;
    if (!s) return [];
    const auth: DependabotCredential =
      s.kind === "token" ? { token: s.value } : { username: s.username ?? "", password: s.value };
    const pathOf = r.url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    switch (r.ecosystem) {
      case "npm":
        return [{ type: "npm_registry", registry: pathOf, url: r.url, ...auth }];
      case "pypi":
        return [{ type: "python_index", "index-url": r.url, "replaces-base": false, ...auth }];
      case "maven":
        return [{ type: "maven_repository", url: r.url, ...auth }];
      case "cargo":
        return [{ type: "cargo_registry", registry: r.scope ?? r.host, url: r.url, ...auth }];
      case "rubygems":
        return [{ type: "rubygems_server", host: r.host, url: r.url, ...auth }];
      case "go":
        return [{ type: "goproxy_server", url: r.url, ...auth }];
      default:
        return [];
    }
  });
}

/** The job document the CLI reads with `-f` (`{ job: … }`), as an object. */
export function buildJob(input: JobInput) {
  const name = (n: string) => dependabotName(input.ecosystem, n);
  const directories = [...new Set(input.roots.map(dependabotDirectory))].sort();
  const configIgnores = (input.ignore ?? []).map((c) => ({
    "dependency-name": name(c.dependencyName),
    source: "teire.yml",
    ...(c.versionRequirement ? { "version-requirement": c.versionRequirement } : {}),
    ...(c.updateTypes?.length ? { "update-types": c.updateTypes } : {}),
  }));
  const job: Record<string, unknown> = {
    command: input.shape.kind === "recreate" ? "recreate" : "update",
    "package-manager": PACKAGE_MANAGER[input.manager],
    source: {
      provider: "github",
      repo: input.repo,
      commit: input.commit,
      ...(directories.length === 1 ? { directory: directories[0] } : { directories }),
    },
    // Teire applies the repo's cooldown when it picks T; the job itself must not delay T again.
    cooldown: { "default-days": 0 },
    "reject-external-code": !!input.privateCredentials && !input.allowExternalCode,
    ...(input.repoPrivate ? { "repo-private": true } : {}),
    ...(input.versioningStrategy ? { "requirements-update-strategy": input.versioningStrategy } : {}),
    ...(input.vendor ? { "vendor-dependencies": true } : {}),
    ...(input.excludePaths?.length ? { "exclude-paths": input.excludePaths } : {}),
    ...(input.commitMessage
      ? {
          "commit-message-options": {
            ...(input.commitMessage.prefix ? { prefix: input.commitMessage.prefix } : {}),
            ...(input.commitMessage.prefixDevelopment
              ? { "prefix-development": input.commitMessage.prefixDevelopment }
              : {}),
            ...(input.commitMessage.includeScope ? { "include-scope": true } : {}),
          },
        }
      : {}),
  };
  const shape = input.shape;
  switch (shape.kind) {
    case "version":
    case "recreate":
      Object.assign(job, {
        dependencies: [name(shape.dependency)],
        "allowed-updates": [{ "dependency-name": name(shape.dependency) }],
        "ignore-conditions": [
          ...configIgnores,
          {
            "dependency-name": name(shape.dependency),
            source: "teire",
            "version-requirement": `> ${shape.target}`,
          },
        ],
      });
      break;
    case "security":
      Object.assign(job, {
        dependencies: [name(shape.dependency)],
        "allowed-updates": [{ "dependency-name": name(shape.dependency) }],
        "security-updates-only": true,
        "security-advisories": shape.advisories.map((a) => ({
          "dependency-name": name(a.dependencyName),
          "affected-versions": a.affectedVersions,
          "patched-versions": a.patchedVersions,
          "unaffected-versions": a.unaffectedVersions,
        })),
        ...(configIgnores.length ? { "ignore-conditions": configIgnores } : {}),
      });
      break;
    case "refresh":
      Object.assign(job, {
        dependencies: [name(shape.dependency)],
        "allowed-updates": [{ "dependency-name": name(shape.dependency) }],
        "updating-a-pull-request": true,
        "existing-pull-requests": [
          {
            ...(shape.prNumber ? { "pr-number": shape.prNumber } : {}),
            dependencies: directories.map((directory) => ({
              "dependency-name": name(shape.dependency),
              "dependency-version": shape.version,
              directory,
            })),
          },
        ],
        "ignore-conditions": [
          ...configIgnores,
          {
            "dependency-name": name(shape.dependency),
            source: "teire",
            "version-requirement": `> ${shape.version}`,
          },
        ],
      });
      break;
    case "group-refresh":
      Object.assign(job, {
        dependencies: shape.members.map((m) => name(m.name)),
        "updating-a-pull-request": true,
        "dependency-group-to-refresh": shape.group,
        "dependency-groups": (input.groups ?? []).map((g) => ({
          name: g.name,
          ...(g.appliesTo ? { "applies-to": g.appliesTo } : {}),
          rules: g.rules,
        })),
        "existing-group-pull-requests": [
          {
            "dependency-group-name": shape.group,
            dependencies: shape.members.map((m) => ({
              "dependency-name": name(m.name),
              "dependency-version": m.version,
            })),
          },
        ],
        ...(configIgnores.length ? { "ignore-conditions": configIgnores } : {}),
      });
      break;
  }
  return { job };
}

/** The job as the YAML file `dependabot update -f` reads. */
export function jobYaml(input: JobInput) {
  return YAML.stringify(buildJob(input));
}
