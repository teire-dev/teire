import { GO } from "../constants";
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
