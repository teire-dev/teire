import { and, eq, providerSources, providers, registryCache } from "@teire/db";
import type { ProviderRecord } from "@teire/engine/providers";
import { cacheLife, cacheTag } from "next/cache";
import { database } from "./db";

/** The registry versions the worker cached (engine `PackageInfo`, read as stored). */
export interface PackageInfo {
  ecosystem: string;
  name: string;
  versions: { version: string; publishedAt: string | null; deprecated: string | null; isDefault: boolean }[];
  defaultVersion: string | null;
  source: { name: string; url: string; checkedAt: string };
}

/**
 * Provider and package pages (C10): what Teire stored while scanning repositories that use them.
 * Cached with the catalog; refreshed when the worker writes.
 */
export async function providerPage(slug: string) {
  "use cache";
  cacheTag("catalog");
  cacheLife("hours");
  const db = database();
  const [row] = await db.select().from(providers).where(eq(providers.slug, slug)).limit(1);
  if (!row) return null;
  const record = row.record as ProviderRecord;
  // A source a repo named in its own teire.yml stays private (D53).
  if (record.discovery?.via.includes("teire.yml")) return null;
  const sources = await db
    .select({
      kind: providerSources.kind,
      url: providerSources.url,
      status: providerSources.status,
      lastCheckedAt: providerSources.lastCheckedAt,
      lastOkAt: providerSources.lastOkAt,
      error: providerSources.error,
    })
    .from(providerSources)
    .where(eq(providerSources.providerSlug, slug));
  return {
    record,
    sources: sources.map((s) => ({
      ...s,
      lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
      lastOkAt: s.lastOkAt?.toISOString() ?? null,
    })),
  };
}

/** The registry's versions for a package, as the worker last read them (deps.dev or npm). */
export async function packageVersions(ecosystem: string, name: string) {
  "use cache";
  cacheTag("catalog");
  cacheLife("hours");
  const [row] = await database()
    .select({ data: registryCache.data, fetchedAt: registryCache.fetchedAt })
    .from(registryCache)
    .where(and(eq(registryCache.ecosystem, ecosystem), eq(registryCache.name, name)))
    .limit(1);
  const info = row?.data as PackageInfo | undefined;
  return info?.versions ? { info, fetchedAt: row?.fetchedAt.toISOString() ?? null } : null;
}
