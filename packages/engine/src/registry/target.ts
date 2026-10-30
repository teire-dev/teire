import { REGISTRY } from "../constants";
import type { DependencyInstance } from "../contract";
import type { PackageInfo, VersionInfo } from "./types";
import type { VersionScheme } from "./versions";

/**
 * Target-version policy (plan D71, card C4): the newest stable version that clears the cooldown and
 * the repo's pins, never above the registry's default tag; after two failed verifications the
 * caller asks again with `fallbackMajors + 1`. Advisories take the smallest fixed version instead,
 * with no cooldown. Every newer version left out is listed with its reason for the PR body.
 */
export interface TargetPin {
  /** A range in the ecosystem's grammar, or a non-registry specifier (alias, path, URL). */
  value: string;
  source: string;
}

export interface TargetPolicy {
  now: Date;
  /** Minimum age in minutes for this version (repo gates may exempt single versions). */
  minAgeMinutes(version: string): number;
  pins: TargetPin[];
  allowPrerelease: boolean;
  fallbackMajors: number;
  /** Why a version cannot be used here at all (e.g. it requires a newer Python), or null. */
  exclude?: (version: string) => string | null;
  /**
   * The highest version allowed, with why: dependabot-core's updater resolved the package only this
   * far (D103), so the target becomes it and is diffed again.
   */
  max?: { version: string; reason: string };
  /** Update types the repository ignores for this package (`@teire ignore <package> major`, D112). */
  ignoreUpdates?: ("major" | "minor" | "patch")[];
}

/** Dependabot's update types: leaving the caret range is major; otherwise a new minor, or a patch. */
function updateType(scheme: VersionScheme, from: string, to: string): "major" | "minor" | "patch" {
  if (scheme.breaking(from, to)) return "major";
  const minor = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 2).join(".");
  return minor(from) === minor(to) ? "patch" : "minor";
}

/** The policy capped for one package, when the options carry a cap for it (D103). */
export function withTargetMax(
  policy: TargetPolicy,
  name: string,
  options: {
    targetMax?: { name: string; version: string; reason: string };
    ignoreUpdates?: { name: string; types: ("major" | "minor" | "patch")[] }[];
  },
): TargetPolicy {
  const cap = options.targetMax;
  const ignored = (options.ignoreUpdates ?? []).filter((i) => i.name === name).flatMap((i) => i.types);
  return {
    ...policy,
    ...(cap && cap.name === name ? { max: { version: cap.version, reason: cap.reason } } : {}),
    ...(ignored.length ? { ignoreUpdates: [...new Set(ignored)] } : {}),
  };
}

export type SkipReason =
  | "incompatible"
  | "prerelease"
  | "above-default"
  | "deprecated"
  | "pinned"
  | "cooldown"
  | "unknown-age"
  | "fallback";

export interface Skipped {
  reason: SkipReason;
  count: number;
  /** Newest first, at most `REGISTRY.maxSkippedListed`. */
  versions: string[];
  detail: string;
}

export type TargetDecision =
  | {
      kind: "upgrade";
      from: string;
      to: string;
      /** Outside the caret range of `from` (a new major, or a new minor on 0.x): the surface is diffed. */
      isMajor: boolean;
      publishedAt: string | null;
      fallbackMajors: number;
      /** Advisory targets ignore the cooldown; true when this one is younger than it. */
      cooldownWaived: boolean;
      skipped: Skipped[];
    }
  | { kind: "up-to-date"; from: string; skipped: Skipped[] }
  | { kind: "blocked"; from: string; reason: string; skipped: Skipped[] };

const MINUTE = 60_000;

function collect(skips: Map<SkipReason, { versions: string[]; detail: string }>) {
  return [...skips].map(([reason, { versions, detail }]) => ({
    reason,
    count: versions.length,
    versions: versions.slice(0, REGISTRY.maxSkippedListed),
    detail,
  }));
}

function checkPins(scheme: VersionScheme, pins: TargetPin[]) {
  const nonRegistry = pins.find((p) => !scheme.isRange(p.value));
  return nonRegistry ? `pinned to "${nonRegistry.value}" by ${nonRegistry.source}` : null;
}

function reasonFor(
  v: VersionInfo,
  scheme: VersionScheme,
  policy: TargetPolicy,
  defaultVersion: string | null,
  applyAge: boolean,
): { reason: SkipReason; detail: string } | null {
  if (!policy.allowPrerelease && scheme.isPrerelease(v.version))
    return { reason: "prerelease", detail: "pre-release versions are not proposed" };
  const excluded = policy.exclude?.(v.version);
  if (excluded) return { reason: "incompatible", detail: excluded };
  if (defaultVersion && scheme.compare(v.version, defaultVersion) > 0)
    return { reason: "above-default", detail: `newer than the registry's default version ${defaultVersion}` };
  if (v.deprecated !== null)
    return { reason: "deprecated", detail: v.deprecated ? `deprecated: ${v.deprecated}` : "deprecated" };
  if (policy.max && scheme.compare(v.version, policy.max.version) > 0)
    return { reason: "pinned", detail: `above ${policy.max.version}: ${policy.max.reason}` };
  const pin = policy.pins.find((p) => !scheme.satisfies(v.version, p.value));
  if (pin) return { reason: "pinned", detail: `outside "${pin.value}" (${pin.source})` };
  if (applyAge) {
    const minutes = policy.minAgeMinutes(v.version);
    if (minutes > 0) {
      if (!v.publishedAt) return { reason: "unknown-age", detail: "the registry gives no publish date" };
      const age = (policy.now.getTime() - new Date(v.publishedAt).getTime()) / MINUTE;
      if (age < minutes)
        return {
          reason: "cooldown",
          detail: `younger than the ${formatMinutes(minutes)} cooldown (newest published ${v.publishedAt.slice(0, 10)})`,
        };
    }
  }
  return null;
}

export function formatMinutes(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${Math.round(minutes)} min`;
}

function stableDefault(info: PackageInfo, scheme: VersionScheme) {
  const d = info.defaultVersion;
  return d && scheme.valid(d) && !scheme.isPrerelease(d) ? d : null;
}

export function chooseTarget(
  info: PackageInfo,
  current: string,
  policy: TargetPolicy,
  scheme: VersionScheme,
): TargetDecision {
  const skips = new Map<SkipReason, { versions: string[]; detail: string }>();
  if (!scheme.valid(current))
    return { kind: "blocked", from: current, reason: `"${current}" is not a registry version`, skipped: [] };
  const pinned = checkPins(scheme, policy.pins);
  if (pinned) return { kind: "blocked", from: current, reason: pinned, skipped: [] };

  const defaultVersion = stableDefault(info, scheme);
  const eligible: VersionInfo[] = [];
  const newer = info.versions.filter((v) => scheme.compare(v.version, current) > 0).reverse();
  for (const v of newer) {
    const kind = policy.ignoreUpdates?.length ? updateType(scheme, current, v.version) : null;
    const why =
      kind && policy.ignoreUpdates?.includes(kind)
        ? {
            reason: "pinned" as const,
            detail: `${kind} updates are ignored for this package (\`@teire ignore … ${kind}\`)`,
          }
        : reasonFor(v, scheme, policy, defaultVersion, true);
    if (!why) {
      eligible.push(v);
      continue;
    }
    const entry = skips.get(why.reason) ?? { versions: [], detail: why.detail };
    entry.versions.push(v.version);
    skips.set(why.reason, entry);
  }
  const newest = eligible[0];
  if (!newest) return { kind: "up-to-date", from: current, skipped: collect(skips) };

  const ceiling = scheme.major(newest.version) - policy.fallbackMajors;
  const pick = eligible.find((v) => scheme.major(v.version) <= ceiling);
  const above = eligible.filter((v) => scheme.major(v.version) > ceiling).map((v) => v.version);
  if (above.length)
    skips.set("fallback", {
      versions: above,
      detail: `falling back ${policy.fallbackMajors} major${policy.fallbackMajors === 1 ? "" : "s"} after failed verifications`,
    });
  if (!pick)
    return {
      kind: "blocked",
      from: current,
      reason: `no version left after falling back ${policy.fallbackMajors} majors`,
      skipped: collect(skips),
    };
  return {
    kind: "upgrade",
    from: current,
    to: pick.version,
    isMajor: scheme.breaking(current, pick.version),
    publishedAt: pick.publishedAt,
    fallbackMajors: policy.fallbackMajors,
    cooldownWaived: false,
    skipped: collect(skips),
  };
}

/**
 * Smallest fixed version for an advisory: the first `fixedIn` entry above the current version,
 * then the oldest published version at or above it on that release line that is stable, not
 * deprecated and inside the pins. The cooldown does not apply to security fixes.
 */
export function chooseFixedTarget(
  info: PackageInfo,
  current: string,
  fixedIn: string[],
  policy: TargetPolicy,
  scheme: VersionScheme,
): TargetDecision {
  const skips = new Map<SkipReason, { versions: string[]; detail: string }>();
  if (!scheme.valid(current))
    return { kind: "blocked", from: current, reason: `"${current}" is not a registry version`, skipped: [] };
  const pinned = checkPins(scheme, policy.pins);
  if (pinned) return { kind: "blocked", from: current, reason: pinned, skipped: [] };
  const fixed = fixedIn
    .filter((f) => scheme.valid(f))
    .sort((a, b) => scheme.compare(a, b))
    .find((f) => scheme.compare(f, current) > 0);
  if (!fixed) return { kind: "blocked", from: current, reason: "no fixed version is published", skipped: [] };

  // Oldest first: stop at the first usable version on the fix's release line.
  let pick: VersionInfo | undefined;
  let firstUsable: VersionInfo | undefined;
  for (const v of info.versions.filter((v) => scheme.compare(v.version, fixed) >= 0)) {
    const why = reasonFor(v, scheme, policy, null, false);
    if (!why) {
      firstUsable ??= v;
      if (scheme.major(v.version) === scheme.major(fixed)) {
        pick = v;
        break;
      }
      continue;
    }
    const entry = skips.get(why.reason) ?? { versions: [], detail: why.detail };
    entry.versions.unshift(v.version);
    skips.set(why.reason, entry);
  }
  pick ??= firstUsable;
  if (!pick)
    return {
      kind: "blocked",
      from: current,
      reason: `no usable version at or above the fix ${fixed}`,
      skipped: collect(skips),
    };
  const minutes = policy.minAgeMinutes(pick.version);
  const young =
    minutes > 0 &&
    (!pick.publishedAt || (policy.now.getTime() - new Date(pick.publishedAt).getTime()) / MINUTE < minutes);
  return {
    kind: "upgrade",
    from: current,
    to: pick.version,
    isMajor: scheme.breaking(current, pick.version),
    publishedAt: pick.publishedAt,
    fallbackMajors: 0,
    cooldownWaived: young,
    skipped: collect(skips),
  };
}

/**
 * D-37: a dependency no lockfile pins (a lockless repository, a range-only requirement) is compared
 * from the lowest published, non-pre-release version its declared range allows: the oldest version a
 * fresh install may still get, so a break between it and the target is one the code can meet. Null
 * when the range isn't a registry range or nothing published satisfies it.
 */
export function rangeFloor(
  info: PackageInfo,
  range: string | undefined,
  scheme: VersionScheme,
): string | null {
  if (!range || !scheme.isRange(range)) return null;
  return (
    info.versions.find((v) => !scheme.isPrerelease(v.version) && scheme.satisfies(v.version, range))
      ?.version ?? null
  );
}

/**
 * A range-only dependency's decision: a target its range already allows changes nothing (a fresh
 * install takes it), so only a target past the range is an upgrade, the range moving to it.
 */
export function beyondRange(decision: TargetDecision, range: string, scheme: VersionScheme): TargetDecision {
  return decision.kind === "upgrade" && scheme.satisfies(decision.to, range)
    ? { kind: "up-to-date", from: decision.from, skipped: decision.skipped }
    : decision;
}

/**
 * The version a dependency is compared from: the locked one, or for a range-only dependency its
 * range's floor, marked `range-floor`. Null when neither is known (it stays unresolved).
 */
export function comparedInstance<T extends DependencyInstance>(
  instance: T,
  info: PackageInfo,
  scheme: VersionScheme,
): T | null {
  if (instance.version) return instance;
  const floor = rangeFloor(info, instance.declaredRange, scheme);
  return floor ? { ...instance, version: floor, resolvedBy: "range-floor" } : null;
}

/**
 * A patched package (D-23: Yarn's `patch:`, pnpm's `patchedDependencies`, patch-package) keeps its
 * patch only on the version it was made for, so an upgrade is reported but held: the patch has to
 * be remade against the target first, and Teire never drops it.
 */
export function patchedHold(
  decision: TargetDecision,
  instance: Pick<DependencyInstance, "name" | "sourceRef">,
) {
  const file = instance.sourceRef?.startsWith("patch:") ? instance.sourceRef.slice("patch:".length) : null;
  if (!file || decision.kind !== "upgrade") return decision;
  return {
    kind: "blocked",
    from: decision.from,
    reason: `${instance.name} is patched by ${file}, made for ${decision.from}: remake the patch for ${decision.to}, then upgrade`,
    skipped: decision.skipped,
  } satisfies TargetDecision;
}
