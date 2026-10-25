import type { Ecosystem } from "../contract";

/** One published version as every registry reader reports it. */
export interface VersionInfo {
  version: string;
  publishedAt: string | null;
  /** Deprecation or yank message; empty string when flagged without a message. */
  deprecated: string | null;
  /** The registry's default version (npm `latest` dist-tag). */
  isDefault: boolean;
}

export interface PackageInfo {
  ecosystem: Ecosystem;
  name: string;
  /** Ascending by the ecosystem's version grammar; versions it cannot parse are dropped. */
  versions: VersionInfo[];
  defaultVersion: string | null;
  source: { name: "deps.dev" | "npm"; url: string; contentHash: string; checkedAt: string };
}

/** One row of `registry_cache` (global, keyed by ecosystem + key). */
export interface CacheEntry {
  etag: string | null;
  lastModified: string | null;
  bodyHash: string;
  data: unknown;
  fetchedAt: string;
}

/** A package registry, or another source cached the same way (runtime end-of-life dates). */
export type CacheScope = Ecosystem | "endoflife";

/** Storage for registry answers. The worker backs it with Postgres; scripts and tests use memory. */
export interface RegistryCache {
  get(scope: CacheScope, key: string): Promise<CacheEntry | null>;
  put(scope: CacheScope, key: string, entry: CacheEntry): Promise<void>;
}

export function memoryCache(): RegistryCache {
  const rows = new Map<string, CacheEntry>();
  return {
    get: async (ecosystem, key) => rows.get(`${ecosystem}\u0000${key}`) ?? null,
    put: async (ecosystem, key, entry) => {
      rows.set(`${ecosystem}\u0000${key}`, entry);
    },
  };
}
