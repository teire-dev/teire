import * as pep440 from "@renovatebot/pep440";
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

/**
 * PEP 440 for PyPI, through @renovatebot/pep440 (ordering agrees with `packaging` 26.3 on every
 * case the research checked; range containment of explicit pre-releases differs, so pre-releases
 * are excluded by `isPrerelease` before any range check, research python.md §2).
 */
export const pypiScheme: VersionScheme = {
  valid: (v) => pep440.valid(v) !== null,
  compare: (a, b) => pep440.compare(a, b),
  isPrerelease: (v) => {
    const parts = pep440.explain(v);
    return !!parts && (parts.is_prerelease || parts.is_devrelease);
  },
  major: (v) => pep440.major(v),
  satisfies: (v, range) => pep440.satisfies(v, range, { prereleases: false }),
  isRange: (range) => range.trim() === "" || pep440.validRange(range),
};

const SCHEMES: Partial<Record<Ecosystem, VersionScheme>> = { npm: npmScheme, pypi: pypiScheme };

export function versionScheme(ecosystem: Ecosystem): VersionScheme {
  const scheme = SCHEMES[ecosystem];
  if (!scheme) throw new Error(`no version scheme for ${ecosystem} yet`);
  return scheme;
}
