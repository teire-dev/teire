import type { DependencyInstance } from "../contract";
import type { TargetPolicy } from "../registry/target";
import { versionScheme } from "../registry/versions";
import { DEPENDABOT_ECOSYSTEM, type DependabotConfig, type DependabotUpdate, updateFor } from "./config";
import type { TeireManager } from "./job";

/**
 * dependabot.yml at target choice (S18.6): the scan and Teire's own transactions honour the same
 * `updates` entry the resolver's jobs do. Its ignores and allow list hold an update, its cooldown
 * sets the release age, `versioning-strategy` the range edit, and `open-pull-requests-limit: 0`
 * turns version updates off. `teire.yml` wins where it sets the same thing, and says so.
 */
export interface DependabotScan {
  config: DependabotConfig;
  /** `teire.yml` keys the repo or its org set (`upgrades.cooldownDays`), which win over dependabot.yml. */
  explicit: string[];
}

/** A project's manager as dependabot.yml's `package-ecosystem` names it. */
function managerOf(ecosystem: string, manager: string): TeireManager | null {
  if (manager in DEPENDABOT_ECOSYSTEM) return manager as TeireManager;
  if (manager === "pip-tools") return "pip-compile";
  return (
    ({ npm: "npm", pypi: "pip", go: "go", cargo: "cargo", rubygems: "bundler", maven: "maven" } as const)[
      ecosystem as "npm"
    ] ?? null
  );
}

export function dependabotUpdate(
  scan: DependabotScan | undefined,
  ecosystem: string,
  project: { manager: string; root: string },
) {
  if (!scan?.config.updates.length) return null;
  const manager = managerOf(ecosystem, project.manager);
  return manager ? updateFor(scan.config, manager, project.root) : null;
}

/** dependabot.yml's `dependency-name`, where `*` matches any run of characters. */
function nameMatches(pattern: string, name: string) {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${re}$`, "i").test(name);
}

const UPDATE_TYPE = {
  "version-update:semver-major": "major",
  "version-update:semver-minor": "minor",
  "version-update:semver-patch": "patch",
} as const;

/** dependabot.yml's `dependency-type` against an instance. */
function typeMatches(type: string, i: Pick<DependencyInstance, "direct" | "scope">) {
  switch (type) {
    case "direct":
      return i.direct;
    case "indirect":
      return !i.direct;
    case "production":
      return i.direct && i.scope !== "dev" && i.scope !== "test";
    case "development":
      return i.direct && (i.scope === "dev" || i.scope === "test");
    default:
      return true;
  }
}

/** Days from dependabot.yml's `cooldown` for an update of this type, or null when it doesn't apply. */
function cooldownDays(update: DependabotUpdate, name: string, type: "major" | "minor" | "patch") {
  const c = update.cooldown;
  if (!c) return null;
  const include = Array.isArray(c.include) ? (c.include as string[]) : null;
  const exclude = Array.isArray(c.exclude) ? (c.exclude as string[]) : [];
  if (include && !include.some((p) => nameMatches(p, name))) return null;
  if (exclude.some((p) => nameMatches(p, name))) return null;
  const days = c[`semver-${type}-days`] ?? c["default-days"];
  return typeof days === "number" ? days : null;
}

function updateTypeOf(ecosystem: string, from: string, to: string): "major" | "minor" | "patch" {
  const scheme = versionScheme(ecosystem as "npm");
  if (scheme.breaking(from, to)) return "major";
  const minor = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 2).join(".");
  return minor(from) === minor(to) ? "patch" : "minor";
}

/**
 * The target policy with this package's dependabot.yml entry applied, and any setting `teire.yml`
 * overrode (said once per scan in its coverage notes).
 */
export function withDependabot(
  policy: TargetPolicy,
  scan: DependabotScan | undefined,
  ecosystem: string,
  project: { manager: string; root: string },
  instance: DependencyInstance,
): { policy: TargetPolicy; conflicts: string[] } {
  const update = dependabotUpdate(scan, ecosystem, project);
  if (!update || !scan) return { policy, conflicts: [] };
  const conflicts: string[] = [];
  const name = instance.name;
  const from = scan.config.path ?? "dependabot.yml";
  const next: TargetPolicy = { ...policy };

  // `open-pull-requests-limit: 0` is Dependabot's way to turn version updates off (security stays).
  if (update.openPullRequestsLimit === 0 && !scan.explicit.includes("pullRequests.limit"))
    next.ignored = `version updates are off in ${from} (open-pull-requests-limit: 0)`;

  // allow: only listed names or dependency types get version updates.
  if (
    update.allow.length &&
    !update.allow.some(
      (a) =>
        (!a.dependencyName || nameMatches(a.dependencyName, name)) &&
        (!a.dependencyType || typeMatches(a.dependencyType, instance)),
    )
  )
    next.ignored ??= `not in ${from}'s allow list`;

  // ignore: a whole package, some versions, or some update types.
  const types = new Set(policy.ignoreUpdates ?? []);
  const ranges: string[] = [];
  for (const c of update.ignore.filter((i) => nameMatches(i.dependencyName, name))) {
    if (!c.versionRequirement && !c.updateTypes?.length) next.ignored ??= `ignored in ${from}`;
    for (const t of c.updateTypes ?? []) {
      const type = UPDATE_TYPE[t as keyof typeof UPDATE_TYPE];
      if (type) types.add(type);
    }
    if (c.versionRequirement) ranges.push(c.versionRequirement);
  }
  if (types.size) next.ignoreUpdates = [...types];
  if (ranges.length) {
    const scheme = versionScheme(ecosystem as "npm");
    const before = policy.exclude;
    next.exclude = (v) => {
      const hit = ranges.find((r) => {
        try {
          return scheme.satisfies(v, r);
        } catch {
          return false;
        }
      });
      return hit ? `ignored in ${from} (${hit})` : (before?.(v) ?? null);
    };
  }

  // cooldown: dependabot.yml's, unless teire.yml sets its own.
  if (update.cooldown) {
    if (scan.explicit.includes("upgrades.cooldownDays"))
      conflicts.push(`cooldown: teire.yml's upgrades.cooldownDays is used, not ${from}'s cooldown`);
    else if (instance.version) {
      const current = instance.version;
      const base = policy.minAgeMinutes;
      next.minAgeMinutes = (v) => {
        const days = cooldownDays(update, name, updateTypeOf(ecosystem, current, v));
        return days === null ? base(v) : days * 1440;
      };
    }
  }

  // versioning-strategy: lockfile-only keeps every target inside the declared range.
  if (update.versioningStrategy === "lockfile-only" && instance.declaredRange) {
    if (scan.explicit.includes("upgrades.versioning"))
      conflicts.push(`versioning: teire.yml's upgrades.versioning is used, not ${from}'s lockfile-only`);
    else
      next.pins = [
        ...policy.pins,
        { value: instance.declaredRange, source: `${from} versioning-strategy: lockfile-only` },
      ];
  }
  return { policy: next, conflicts };
}

/** dependabot.yml's `versioning-strategy` as `upgrades.versioning`, when teire.yml doesn't set one. */
export function dependabotVersioning(
  scan: DependabotScan | undefined,
  ecosystem: string,
  project: { manager: string; root: string },
): "auto" | "increase" | "widen" | null {
  if (!scan || scan.explicit.includes("upgrades.versioning")) return null;
  const strategy = dependabotUpdate(scan, ecosystem, project)?.versioningStrategy;
  if (strategy === "widen") return "widen";
  if (strategy === "increase" || strategy === "increase-if-necessary") return "increase";
  if (strategy === "auto") return "auto";
  return null;
}
