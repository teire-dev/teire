import {
  and,
  type Database,
  dependencyCaches,
  desc,
  eq,
  extractionCache,
  inArray,
  registryCache,
  surfaceDiffs,
} from "@teire/db";
import { DOWNLOAD_CACHE, GO, JVM, PYTHON, RUBY, RUST, SURFACE } from "@teire/engine/constants";
import type { RegistryCache } from "@teire/engine/registry";
import {
  jvmSurfaceDiff,
  type NpmSurfaceOptions,
  npmSurfaceDiff,
  pypiSurfaceDiff,
  rubySurfaceDiff,
  type SurfaceDiff,
} from "@teire/engine/surface";
import type { CacheRecord, VerifySession } from "@teire/engine/verify";

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

/** How many saved caches a root keeps: the newest restores; one more covers a save that fails half-way. */
const CACHES_KEPT = 2;

/**
 * A repository's download cache for one root (R21.11). Every restore is looked up here, by the run's
 * own repository, never handed in, so a cache can't cross repositories (R21 reviews: a public
 * lockfile would otherwise let one repository write the cache another restores). Only the package
 * manager's download directory is saved, after the baseline installs; older records are pruned.
 * Undefined where the backend keeps no cache or the manager has no download directory.
 */
export function dependencyCacheFor(
  db: Database,
  repoId: number,
  ecosystem: string,
  root: string,
  manager: string,
  backend: string,
) {
  const dir = DOWNLOAD_CACHE[manager];
  // On only once the sandbox Worker has its R2 bucket (`TEIRE_DEP_CACHE=on`, set when R2 is enabled).
  if (process.env.TEIRE_DEP_CACHE !== "on" || backend !== "cloudflare" || !dir) return undefined;
  const key = and(
    eq(dependencyCaches.repoId, repoId),
    eq(dependencyCaches.ecosystem, ecosystem),
    eq(dependencyCaches.root, root),
  );
  return {
    async restore(session: VerifySession) {
      if (!session.depCache) return null;
      const [row] = await db
        .select()
        .from(dependencyCaches)
        .where(key)
        .orderBy(desc(dependencyCaches.createdAt))
        .limit(1);
      if (!row) return null;
      const { ms } = await session.depCache.restore(row.record as CacheRecord);
      return { ms, savedAt: row.createdAt.toISOString() };
    },
    async save(session: VerifySession) {
      if (!session.depCache) return null;
      const name = `${repoId}-${ecosystem}-${root}`.replace(/[^\w.-]/g, "_");
      const { record, ms } = await session.depCache.save(dir, name);
      await db.insert(dependencyCaches).values({ repoId, ecosystem, root, record, sizeBytes: record.size });
      const old = (
        await db.select().from(dependencyCaches).where(key).orderBy(desc(dependencyCaches.createdAt))
      ).slice(CACHES_KEPT);
      for (const row of old) await session.depCache.remove(row.record as CacheRecord).catch(() => undefined);
      if (old.length)
        await db.delete(dependencyCaches).where(
          inArray(
            dependencyCaches.id,
            old.map((r) => r.id),
          ),
        );
      return { ms };
    },
  };
}

/** A repository's cache records, gone when it is removed or uninstalled (R21.11). */
export async function forgetDependencyCaches(db: Database, repoIds: number[]) {
  if (!repoIds.length) return;
  await db.delete(dependencyCaches).where(inArray(dependencyCaches.repoId, repoIds));
}
