import { REGISTRY } from "../constants";
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
    const why = reasonFor(v, scheme, policy, defaultVersion, true);
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
    isMajor: scheme.major(pick.version) > scheme.major(current),
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
    isMajor: scheme.major(pick.version) > scheme.major(current),
    publishedAt: pick.publishedAt,
    fallbackMajors: 0,
    cooldownWaived: young,
    skipped: collect(skips),
  };
}
