import { join } from "node:path";
import semver from "semver";
import { SURFACE } from "../constants";
import { getPackageInfo, type RegistryOptions } from "../registry/clients";
import { declarationEntries, readManifest, resolveSubpath, wildcardSubpaths } from "./entries";
import { exportsOnlySurface } from "./lexer";
import { fetchNpmPackage } from "./npm-package";
import { diffSurfaces } from "./ts-diff";
import { extractTsSurface } from "./ts-walk";
import { materializeTypeDeps, typesPackageName } from "./typedeps";
import type { ApiSurface, SurfaceDiff } from "./types";

export interface NpmSurfaceOptions extends RegistryOptions {
  cacheDir?: string;
}

/**
 * DefinitelyTyped stand-in for an untyped package: the highest `@types/<name>` on the library's
 * major, at or below its minor when one exists (their versions track the library only loosely:
 * there is no `@types/express@4.22.x`). Deprecated `@types` packages are stubs and are skipped.
 */
async function definitelyTyped(name: string, version: string, options: NpmSurfaceOptions) {
  const typesName = typesPackageName(name);
  const info = await getPackageInfo("npm", typesName, options);
  if (!info || !semver.valid(version)) return null;
  const major = semver.major(version);
  const minor = semver.minor(version);
  const sameMajor = info.versions.filter(
    (v) => v.deprecated === null && !semver.prerelease(v.version) && semver.major(v.version) === major,
  );
  const atOrBelow = sameMajor.filter((v) => semver.minor(v.version) <= minor);
  const pick = (atOrBelow.length ? atOrBelow : sameMajor).at(-1);
  if (!pick) return null;
  return { name: typesName, version: pick.version, approximate: semver.minor(pick.version) !== minor };
}

async function bundledOrTyped(name: string, version: string, dir: string, options: NpmSurfaceOptions) {
  const manifest = readManifest(dir) ?? {};
  const entries = declarationEntries(dir, manifest);
  if (Object.keys(entries.entries).length > 0) {
    const deps = await materializeTypeDeps(dir, options);
    const surface = extractTsSurface({
      pkgDir: dir,
      name,
      version,
      source: { kind: "bundled" },
      entries,
      nodeModules: deps.nodeModules,
      typeDeps: deps.packages.map((p) => p.name),
      cacheDir: options.cacheDir,
    });
    if (deps.unresolved.length)
      surface.note = [surface.note, `type dependencies not resolved: ${deps.unresolved.join(", ")}`]
        .filter(Boolean)
        .join("; ");
    return surface;
  }
  return null;
}

/** The surface of one npm package version, from the best source it has. */
export async function npmSurface(name: string, version: string, options: NpmSurfaceOptions) {
  const started = Date.now();
  const pkg = await fetchNpmPackage(name, version, options);
  let surface: ApiSurface | null = await bundledOrTyped(name, version, pkg.dir, options);
  if (!surface) {
    const dt = await definitelyTyped(name, version, options);
    if (dt) {
      const types = await fetchNpmPackage(dt.name, dt.version, options);
      const typed = await bundledOrTyped(name, version, types.dir, options);
      if (typed) surface = { ...typed, source: { kind: "definitely-typed", ...dt } };
    }
  }
  surface ??= await exportsOnlySurface(pkg.dir, readManifest(pkg.dir) ?? {}, name, version);
  surface ??= {
    name,
    version,
    source: { kind: "bundled" },
    entries: {},
    wildcards: [],
    symbols: {},
    byTypeMember: {},
    aliases: {},
    truncated: false,
    note: "no type declarations, no @types package and no readable JavaScript entry",
  };
  return { surface, integrity: pkg.integrity, dir: pkg.dir, ms: Date.now() - started };
}

/** API-surface diff installed → target, cached by the caller per (package, from, to, tool). */
export async function npmSurfaceDiff(
  name: string,
  fromVersion: string,
  toVersion: string,
  options: NpmSurfaceOptions,
): Promise<SurfaceDiff> {
  const from = await npmSurface(name, fromVersion, options);
  const to = await npmSurface(name, toVersion, options);
  const diff = diffSurfaces(from.surface, to.surface);
  // Deep imports reachable through wildcard exports in the installed version that no longer resolve.
  if (!diff.unanalyzable && from.surface.source.kind === "bundled") {
    const fromManifest = readManifest(from.dir) ?? {};
    const toManifest = readManifest(to.dir) ?? {};
    const deep = wildcardSubpaths(
      from.dir,
      declarationEntries(from.dir, fromManifest),
      SURFACE.maxWildcardFiles,
    );
    for (const subpath of deep) {
      if (subpath in from.surface.entries || resolveSubpath(to.dir, toManifest, subpath) !== null) continue;
      diff.changes.push({
        path: subpath,
        declKey: null,
        kind: "entry-removed",
        severity: "breaking",
        before: resolveSubpath(from.dir, fromManifest, subpath),
        after: null,
      });
      diff.counts["entry-removed"] = (diff.counts["entry-removed"] ?? 0) + 1;
    }
  }
  const side = (s: typeof from) => ({
    source: s.surface.source,
    symbols: Object.keys(s.surface.symbols).length,
    truncated: s.surface.truncated,
    ms: s.ms,
    integrity: s.integrity,
  });
  if (from.surface.source.kind !== to.surface.source.kind)
    diff.notes.push(`types come from ${from.surface.source.kind} before and ${to.surface.source.kind} after`);
  for (const s of [from.surface, to.surface])
    if (s.note) diff.notes.push(`${s.name}@${s.version}: ${s.note}`);
  return {
    ...diff,
    from: side(from),
    to: side(to),
    tool: {
      name: SURFACE.tool,
      version: SURFACE.toolVersion,
      noiseFilterVersion: SURFACE.noiseFilterVersion,
    },
  };
}

/**
 * Where the locator should place one installed version and which directories its declaration
 * keys are relative to: the package itself (or its `@types` stand-in) plus its type-dependency
 * closure, with the same prefixes the walker used.
 */
export async function npmTypesLayout(name: string, version: string, options: NpmSurfaceOptions) {
  const pkg = await fetchNpmPackage(name, version, options);
  const layout = async (as: string, dir: string) => {
    const deps = await materializeTypeDeps(dir, options);
    const base = options.cacheDir ?? SURFACE.cacheDir;
    return {
      link: { as, dir },
      roots: [
        { dir, prefix: "" },
        ...deps.packages.map((p) => ({
          dir: join(base, p.name, p.version, "package"),
          prefix: `node_modules/${p.name}/`,
        })),
      ],
    };
  };
  if (Object.keys(declarationEntries(pkg.dir, readManifest(pkg.dir) ?? {}).entries).length)
    return layout(name, pkg.dir);
  const dt = await definitelyTyped(name, version, options);
  if (dt) {
    const types = await fetchNpmPackage(dt.name, dt.version, options);
    return layout(dt.name, types.dir);
  }
  return { link: { as: name, dir: pkg.dir }, roots: [{ dir: pkg.dir, prefix: "" }] };
}
