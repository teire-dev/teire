import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GO } from "../constants";
import { runGo, scratchHome } from "../golang/toolchain";
import { guardedFetch } from "../net/fetch";
import { getPackageInfo, type RegistryOptions } from "./clients";
import type { PackageInfo } from "./types";
import { goScheme } from "./versions";

/**
 * A Go module's majors are separate module paths (go.dev/ref/mod#major-version-suffixes):
 * `github.com/golang-jwt/jwt/v4` → `/v5`; `gopkg.in/yaml.v2` → `gopkg.in/yaml.v3`; v0/v1 have no
 * suffix. To choose a target across majors, the versions of the installed path and of every higher
 * major path the proxy knows are merged into one list; each version maps back to its path.
 */
export function splitMajor(path: string): { base: string; major: number; style: "slash" | "gopkg" } {
  const gopkg = /^(gopkg\.in\/.+)\.v(\d+)$/.exec(path);
  if (gopkg?.[1]) return { base: gopkg[1], major: Number(gopkg[2]), style: "gopkg" };
  const slash = /^(.+)\/v(\d+)$/.exec(path);
  if (slash?.[1] && Number(slash[2]) >= 2) return { base: slash[1], major: Number(slash[2]), style: "slash" };
  return { base: path, major: 1, style: "slash" };
}

export function pathForMajor(base: string, major: number, style: "slash" | "gopkg") {
  if (style === "gopkg") return `${base}.v${major}`;
  return major <= 1 ? base : `${base}/v${major}`;
}

/** Proxy path escaping: an upper-case letter becomes `!` + lower case (go.dev/ref/mod#goproxy-protocol). */
export function escapeModulePath(path: string) {
  return path.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

async function existsOnProxy(path: string) {
  try {
    const res = await guardedFetch(`${GO.proxy}/${escapeModulePath(path)}/@v/list`, {
      allowHosts: [new URL(GO.proxy).hostname],
    });
    return res.status === 200 && res.text().trim().length > 0;
  } catch {
    return false;
  }
}

export interface GoFamily {
  /** Every version of the installed path and of higher major paths, one list. */
  info: PackageInfo;
  /** Version → the module path that publishes it. */
  pathOf: (version: string) => string;
  majors: string[];
}

export async function goModuleFamily(path: string, options: RegistryOptions): Promise<GoFamily | null> {
  const { base, major, style } = splitMajor(path);
  const own = await getPackageInfo("go", path, options);
  if (!own) return null;
  const owners = new Map(own.versions.map((v) => [v.version, path]));
  const versions = [...own.versions];
  const majors = [path];
  // v0 and v1 share the base path; the next major path is /v2.
  for (let next = Math.max(major, 1) + 1; next <= Math.max(major, 1) + GO.maxMajorProbe; next++) {
    const candidate = pathForMajor(base, next, style);
    if (!(await existsOnProxy(candidate))) break;
    const info = await getPackageInfo("go", candidate, options).catch(() => null);
    if (!info) break;
    majors.push(candidate);
    for (const v of info.versions) {
      owners.set(v.version, candidate);
      versions.push(v);
    }
  }
  const sorted = versions
    .filter((v) => goScheme.valid(v.version))
    .sort((a, b) => goScheme.compare(a.version, b.version));
  const latest = majors.at(-1) === path ? own.defaultVersion : null;
  return {
    info: {
      ...own,
      versions: sorted,
      defaultVersion:
        latest ?? sorted.filter((v) => !goScheme.isPrerelease(v.version)).at(-1)?.version ?? null,
    },
    pathOf: (version) => owners.get(version) ?? path,
    majors,
  };
}

/** A version range the module's authors retracted, with their reason (go.dev/ref/mod#go-mod-file-retract). */
export interface Retraction {
  low: string;
  high: string;
  rationale: string | null;
}

export interface Retractions {
  ranges: Retraction[];
  /** Where they were read: the proxy's go.mod of `@latest`, for the change record's source. */
  source: { url: string; contentHash: string; checkedAt: string } | null;
}

const retracted = new Map<string, Promise<Retractions>>();

/**
 * A module path's retractions. Go reads them from the go.mod of the version the proxy calls
 * `@latest`: the highest release or pre-release before retractions are considered (go.dev/ref/mod),
 * so not Teire's default version, which leaves pre-releases out. Each major path has its own.
 * Parsed by Go's own `go mod edit -json`, which knows every `retract` form and its rationale.
 */
export function goRetractions(path: string): Promise<Retractions> {
  const known = retracted.get(path);
  if (known) return known;
  const pending = (async (): Promise<Retractions> => {
    const host = new URL(GO.proxy).hostname;
    const base = `${GO.proxy}/${escapeModulePath(path)}`;
    const latest = await guardedFetch(`${base}/@latest`, { allowHosts: [host] });
    if (latest.status !== 200) return { ranges: [], source: null };
    const version = (JSON.parse(latest.text()) as { Version?: string }).Version;
    if (!version) return { ranges: [], source: null };
    const url = `${base}/@v/${version}.mod`;
    const mod = await guardedFetch(url, { allowHosts: [host], maxBytes: 1024 * 1024 });
    if (mod.status !== 200) return { ranges: [], source: null };
    const text = mod.text();
    const dir = await mkdtemp(join(tmpdir(), "teire-retract-"));
    const home = await scratchHome();
    try {
      await writeFile(join(dir, "go.mod"), text);
      return {
        ranges: retractionsFromEditJson((await runGo(["mod", "edit", "-json", "go.mod"], dir, home)).stdout),
        source: {
          url,
          contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
          checkedAt: new Date().toISOString(),
        },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  })();
  retracted.set(path, pending);
  pending.catch(() => retracted.delete(path));
  return pending;
}

/** `go mod edit -json`'s `Retract` list (Low, High, Rationale) as Teire's ranges. */
export function retractionsFromEditJson(stdout: string): Retraction[] {
  const edit = JSON.parse(stdout) as { Retract?: { Low: string; High: string; Rationale?: string }[] };
  return (edit.Retract ?? []).map((r) => ({
    low: r.Low,
    high: r.High,
    rationale: r.Rationale?.trim() || null,
  }));
}

/** The retraction covering `version`, inclusive at both ends, or null. */
export function retractionOf(version: string, ranges: readonly Retraction[]): Retraction | null {
  return (
    ranges.find((r) => goScheme.compare(version, r.low) >= 0 && goScheme.compare(version, r.high) <= 0) ??
    null
  );
}

/** A pseudo-version (`v0.0.0-20220906165146-f3363e06e74c`): a commit, not a release. */
export const GO_PSEUDO = /^v?\d+\.\d+\.\d+-(?:0\.|[\w.]+\.0\.)?\d{14}-[0-9a-f]{12}$/;

/** Whether the proxy serves this exact version of the module (a pseudo-version's commit exists). */
export async function goVersionExists(path: string, version: string) {
  try {
    const res = await guardedFetch(`${GO.proxy}/${escapeModulePath(path)}/@v/${version}.info`, {
      allowHosts: [new URL(GO.proxy).hostname],
    });
    return res.status === 200;
  } catch {
    return false;
  }
}
