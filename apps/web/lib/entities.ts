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

/** The fields Teire reads from deps.dev's package response. */
interface DepsDevPackage {
  versions?: {
    versionKey?: { version?: string };
    publishedAt?: string;
    isDefault?: boolean;
    isDeprecated?: boolean;
    deprecatedReason?: string;
  }[];
}

/** deps.dev's name for each ecosystem Teire reads (the engine's `DEPS_DEV_SYSTEM`). */
const DEPS_DEV: Record<string, string> = {
  npm: "NPM",
  pypi: "PYPI",
  maven: "MAVEN",
  go: "GO",
  cargo: "CARGO",
  rubygems: "RUBYGEMS",
};
const REGISTRY_TIMEOUT_MS = 5000;

/**
 * A public package's registry facts when the worker hasn't cached them (revamp S3: a transitive
 * dependency gets a page too), read from deps.dev on demand and kept for hours. Public data only: a
 * package deps.dev doesn't know (a private registry's) has no public page.
 */
async function registryFacts(ecosystem: string, name: string) {
  "use cache";
  cacheLife("hours");
  const system = DEPS_DEV[ecosystem];
  if (!system) return null;
  const url = `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(name)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (res.status !== 200) return null;
    const body = (await res.json()) as DepsDevPackage;
    // Release order is publish order here; the worker's cache orders by each ecosystem's own scheme.
    const versions = (body.versions ?? [])
      .flatMap((v) =>
        v.versionKey?.version
          ? [
              {
                version: v.versionKey.version,
                publishedAt: v.publishedAt ?? null,
                deprecated: v.isDeprecated ? (v.deprecatedReason ?? "") : null,
                isDefault: v.isDefault === true,
              },
            ]
          : [],
      )
      .sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""));
    if (!versions.length) return null;
    const checkedAt = new Date().toISOString();
    const info: PackageInfo = {
      ecosystem,
      name,
      versions,
      defaultVersion: versions.find((v) => v.isDefault)?.version ?? null,
      source: { name: "deps.dev", url, checkedAt },
    };
    return { info, fetchedAt: checkedAt };
  } catch {
    return null;
  }
}

/** A package's registry facts: the worker's cache first, then deps.dev. */
export async function packageFacts(ecosystem: string, name: string) {
  return (await packageVersions(ecosystem, name)) ?? (await registryFacts(ecosystem, name));
}
