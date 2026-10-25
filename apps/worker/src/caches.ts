import { and, type Database, eq, extractionCache, registryCache, surfaceDiffs } from "@teire/db";
import { GO, JVM, PYTHON, RUBY, RUST, SURFACE } from "@teire/engine/constants";
import type { RegistryCache } from "@teire/engine/registry";
import {
  jvmSurfaceDiff,
  type NpmSurfaceOptions,
  npmSurfaceDiff,
  pypiSurfaceDiff,
  rubySurfaceDiff,
  type SurfaceDiff,
} from "@teire/engine/surface";

/** `registry_cache` in Postgres: one row per (ecosystem, key), shared by every repo the worker scans. */
export function postgresRegistryCache(db: Database): RegistryCache {
  return {
    async get(ecosystem, key) {
      const [row] = await db
        .select()
        .from(registryCache)
        .where(and(eq(registryCache.ecosystem, ecosystem), eq(registryCache.name, key)))
        .limit(1);
      if (!row) return null;
      return {
        etag: row.etag,
        lastModified: row.lastModified,
        bodyHash: row.bodyHash,
        data: row.data,
        fetchedAt: row.fetchedAt.toISOString(),
      };
    },
    async put(ecosystem, key, entry) {
      const values = {
        etag: entry.etag,
        lastModified: entry.lastModified,
        bodyHash: entry.bodyHash,
        data: entry.data,
        fetchedAt: new Date(entry.fetchedAt),
      };
      await db
        .insert(registryCache)
        .values({ ecosystem, name: key, ...values })
        .onConflictDoUpdate({ target: [registryCache.ecosystem, registryCache.name], set: values });
    },
  };
}

/**
 * `surface_diffs`: one API-surface diff per (package, from, to, tool, tool version, noise-filter
 * version), computed once and reused by every repo on the same jump (1–10 s and ~0.5 GB per pair).
 */
export async function cachedSurfaceDiff(
  db: Database,
  ecosystem: "npm" | "pypi" | "go" | "cargo" | "rubygems" | "maven",
  name: string,
  fromVersion: string,
  toVersion: string,
  options: NpmSurfaceOptions,
  /** Go: the diff needs the target's module path; (path, from, to) still decide it uniquely. */
  compute?: () => Promise<SurfaceDiff>,
): Promise<SurfaceDiff> {
  const tool =
    ecosystem === "pypi"
      ? PYTHON.surfaceTool
      : ecosystem === "go"
        ? { name: "apidiff", version: GO.apidiffVersion }
        : ecosystem === "cargo"
          ? { name: "cargo-semver-checks", version: RUST.semverChecksVersion }
          : ecosystem === "rubygems"
            ? { name: "teire-prism-surface", version: RUBY.extractorVersion }
            : ecosystem === "maven"
              ? { name: "japicmp", version: JVM.japicmpVersion }
              : { name: SURFACE.tool, version: SURFACE.toolVersion };
  const key = and(
    eq(surfaceDiffs.ecosystem, ecosystem),
    eq(surfaceDiffs.name, name),
    eq(surfaceDiffs.fromVersion, fromVersion),
    eq(surfaceDiffs.toVersion, toVersion),
    eq(surfaceDiffs.tool, tool.name),
    eq(surfaceDiffs.toolVersion, tool.version),
    eq(surfaceDiffs.noiseFilterVersion, SURFACE.noiseFilterVersion),
  );
  const [row] = await db.select({ result: surfaceDiffs.result }).from(surfaceDiffs).where(key).limit(1);
  if (row) return row.result as SurfaceDiff;
  const started = Date.now();
  const diff = compute
    ? await compute()
    : ecosystem === "pypi"
      ? await pypiSurfaceDiff(name, fromVersion, toVersion, options)
      : ecosystem === "rubygems"
        ? await rubySurfaceDiff(name, fromVersion, toVersion)
        : ecosystem === "maven"
          ? await jvmSurfaceDiff(name, fromVersion, toVersion)
          : await npmSurfaceDiff(name, fromVersion, toVersion, options);
  // A Go diff that could not be computed (a private module, a toolchain error) is not cached.
  if (diff.unanalyzable) return diff;
  await db
    .insert(surfaceDiffs)
    .values({
      ecosystem,
      name,
      fromVersion,
      toVersion,
      tool: tool.name,
      toolVersion: tool.version,
      noiseFilterVersion: SURFACE.noiseFilterVersion,
      result: diff,
      symbolCount: diff.from.symbols + diff.to.symbols,
      truncated: diff.from.truncated || diff.to.truncated,
      durationMs: Date.now() - started,
    })
    .onConflictDoNothing();
  return diff;
}

/**
 * `extraction_cache`: one Nemotron reading per (model, exact prompt), so the same notes are never
 * paid for twice. The prompt hash covers the instructions, the sliced documents and the question.
 */
export async function cachedExtraction<T>(
  db: Database,
  model: string,
  promptHash: string,
  compute: () => Promise<{ value: T; costUsd: number }>,
): Promise<{ value: T; cached: boolean }> {
  const key = `${model}:${promptHash}`;
  const [row] = await db.select().from(extractionCache).where(eq(extractionCache.key, key)).limit(1);
  if (row) return { value: row.records as T, cached: true };
  const { value, costUsd } = await compute();
  await db
    .insert(extractionCache)
    .values({ key, model, records: value, costUsd: costUsd.toFixed(6) })
    .onConflictDoNothing();
  return { value, cached: false };
}
