import semver from "semver";
import type { Ecosystem } from "../contract";

/**
 * One version grammar per ecosystem, so the target policy, sorting and range checks stay the same
 * code for all six. npm uses semver; PEP 440, Maven, Go, Cargo and RubyGems schemes are added with
 * their stages.
 */
export interface VersionScheme {
  valid(version: string): boolean;
  compare(a: string, b: string): number;
  isPrerelease(version: string): boolean;
  /** Release line used for "fall back one major". */
  major(version: string): number;
  /** True when `version` satisfies `range` in the ecosystem's own range grammar. */
  satisfies(version: string, range: string): boolean;
  /** True when `range` is a registry range this grammar understands (not a tag, alias, URL or path). */
  isRange(range: string): boolean;
}

export const npmScheme: VersionScheme = {
  valid: (v) => semver.valid(v) !== null,
  compare: (a, b) => semver.compare(a, b),
  isPrerelease: (v) => (semver.prerelease(v)?.length ?? 0) > 0,
  major: (v) => semver.major(v),
  satisfies: (v, range) => semver.satisfies(v, range, { includePrerelease: false }),
  isRange: (range) => semver.validRange(range) !== null,
};

const SCHEMES: Partial<Record<Ecosystem, VersionScheme>> = { npm: npmScheme };

export function versionScheme(ecosystem: Ecosystem): VersionScheme {
  const scheme = SCHEMES[ecosystem];
  if (!scheme) throw new Error(`no version scheme for ${ecosystem} yet`);
  return scheme;
}
