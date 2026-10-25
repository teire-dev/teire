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
  /**
   * True when `to` leaves the caret range of `from`: the leftmost non-zero release number changes
   * or anything left of it does (4.x → 5.x, and 0.27 → 0.28 too, which semver lets break).
   */
  breaking(from: string, to: string): boolean;
  /** True when `version` satisfies `range` in the ecosystem's own range grammar. */
  satisfies(version: string, range: string): boolean;
  /** True when `range` is a registry range this grammar understands (not a tag, alias, URL or path). */
  isRange(range: string): boolean;
}

/** Caret rule over release numbers: anything up to the first non-zero component of `from` changed. */
function caretBreak(from: number[], to: number[]) {
  const first = from.findIndex((n) => n !== 0);
  const upTo = first < 0 ? from.length - 1 : first;
  for (let i = 0; i <= upTo; i++) if ((from[i] ?? 0) !== (to[i] ?? 0)) return true;
  return false;
}

const semverRelease = (v: string) => {
  const p = semver.parse(v);
  return p ? [p.major, p.minor, p.patch] : [];
};

export const npmScheme: VersionScheme = {
  valid: (v) => semver.valid(v) !== null,
  compare: (a, b) => semver.compare(a, b),
  isPrerelease: (v) => (semver.prerelease(v)?.length ?? 0) > 0,
  major: (v) => semver.major(v),
  breaking: (from, to) => caretBreak(semverRelease(from), semverRelease(to)),
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
  breaking: (from, to) => caretBreak(pep440.explain(from)?.release ?? [], pep440.explain(to)?.release ?? []),
  satisfies: (v, range) => pep440.satisfies(v, range, { prereleases: false }),
  isRange: (range) => range.trim() === "" || pep440.validRange(range),
};

/**
 * Go module versions (go.dev/ref/mod#versions): semver with a `v`; pseudo-versions
 * (`v0.0.0-20261007192929-f45ad48fbe92`) sort as pre-releases; `+incompatible` is build metadata.
 * A new major is a new module path (`…/v5`), so `breaking` compares releases within one path and
 * the Go target merges the paths of a module's majors first (registry/go.ts).
 */
const goSemver = (v: string) => v.replace(/^v/, "");
export const goScheme: VersionScheme = {
  valid: (v) => /^v\d/.test(v) && semver.valid(goSemver(v)) !== null,
  compare: (a, b) => semver.compare(goSemver(a), goSemver(b)),
  isPrerelease: (v) => (semver.prerelease(goSemver(v))?.length ?? 0) > 0,
  major: (v) => semver.major(goSemver(v)),
  breaking: (from, to) => caretBreak(semverRelease(goSemver(from)), semverRelease(goSemver(to))),
  satisfies: (v, range) => goSemver(v) === goSemver(range),
  isRange: (range) => /^v\d/.test(range) && semver.valid(goSemver(range)) !== null,
};

const SCHEMES: Partial<Record<Ecosystem, VersionScheme>> = { npm: npmScheme, pypi: pypiScheme, go: goScheme };

export function versionScheme(ecosystem: Ecosystem): VersionScheme {
  const scheme = SCHEMES[ecosystem];
  if (!scheme) throw new Error(`no version scheme for ${ecosystem} yet`);
  return scheme;
}
