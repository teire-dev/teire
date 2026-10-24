import { and, type Database, eq, registryCache } from "@teire/db";
import type { RegistryCache } from "@teire/engine/registry";

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
