import { sha256 } from "../catalog/source";
import { REGISTRY } from "../constants";
import type { Ecosystem } from "../contract";
import { guardedFetch } from "../net/fetch";
import type { CacheEntry, PackageInfo, RegistryCache, VersionInfo } from "./types";
import { versionScheme } from "./versions";

/**
 * Registry readers (plan S02a task 4). deps.dev v3 `GetPackage` gives every version with its
 * publish date and deprecation in one small call for all six ecosystems; npm's own documents fill
 * what deps.dev lacks (repository, types, tarball integrity, peers) and stand in when deps.dev is
 * down. Research: context/09-build-research/generic/js-ts.md §2, cross-cutting.md §3.
 */
const DEPS_DEV_SYSTEM: Record<Ecosystem, string> = {
  npm: "NPM",
  pypi: "PYPI",
  maven: "MAVEN",
  go: "GO",
  cargo: "CARGO",
  rubygems: "RUBYGEMS",
};

interface DepsDevPackage {
  versions?: {
    versionKey?: { version?: string };
    publishedAt?: string;
    isDefault?: boolean;
    isDeprecated?: boolean;
    deprecatedReason?: string;
  }[];
}

interface NpmPackument {
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
  versions?: Record<string, { deprecated?: string }>;
}

/** The fields of npm's `/<name>/<version>` document Teire uses. */
export interface NpmVersionDetail {
  name: string;
  version: string;
  repository: { url: string; directory?: string } | null;
  types: string | null;
  main: string | null;
  exports: unknown;
  type: string | null;
  dist: { tarball: string; integrity: string | null; shasum: string; unpackedSize: number | null };
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  optionalDependencies: Record<string, string>;
  engines: Record<string, string>;
  deprecated: string | null;
  source: { url: string; contentHash: string; checkedAt: string };
}

function npmUrl(name: string, version?: string) {
  const path = name.startsWith("@") ? name.replace("/", "%2f") : name;
  return `https://${REGISTRY.hosts.npm}/${path}${version ? `/${encodeURIComponent(version)}` : ""}`;
}

function isFresh(entry: CacheEntry, now: Date) {
  return now.getTime() - new Date(entry.fetchedAt).getTime() < REGISTRY.depsDevTtlMs;
}

function sortVersions(ecosystem: Ecosystem, versions: VersionInfo[]) {
  const scheme = versionScheme(ecosystem);
  return versions.filter((v) => scheme.valid(v.version)).sort((a, b) => scheme.compare(a.version, b.version));
}

/** Parses a deps.dev `GetPackage` body; exported for fixture tests. */
export function parseDepsDevPackage(
  ecosystem: Ecosystem,
  name: string,
  body: string,
  url: string,
  checkedAt: string,
): PackageInfo {
  const data = JSON.parse(body) as DepsDevPackage;
  const versions = sortVersions(
    ecosystem,
    (data.versions ?? []).flatMap((v) =>
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
    ),
  );
  return {
    ecosystem,
    name,
    versions,
    defaultVersion: versions.find((v) => v.isDefault)?.version ?? null,
    source: { name: "deps.dev", url, contentHash: sha256(body), checkedAt },
  };
}

async function fromDepsDev(ecosystem: Ecosystem, name: string, now: Date): Promise<PackageInfo | null> {
  const url = `https://${REGISTRY.hosts.depsDev}/v3/systems/${DEPS_DEV_SYSTEM[ecosystem]}/packages/${encodeURIComponent(name)}`;
  const res = await guardedFetch(url, { allowHosts: [REGISTRY.hosts.depsDev] });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`deps.dev ${res.status} for ${name}`);
  return parseDepsDevPackage(ecosystem, name, res.text(), url, now.toISOString());
}

async function fromNpm(name: string, previous: CacheEntry | null, now: Date) {
  const url = npmUrl(name);
  const cached = previous && (previous.data as PackageInfo).source?.name === "npm" ? previous : null;
  const res = await guardedFetch(url, {
    allowHosts: [REGISTRY.hosts.npm],
    maxBytes: REGISTRY.maxPackumentBytes,
    headers: { accept: "application/json" },
    etag: cached?.etag,
    lastModified: cached?.lastModified,
  });
  if (res.status === 304 && cached) return { info: cached.data as PackageInfo, res };
  if (res.status === 404) return { info: null, res };
  if (res.status !== 200) throw new Error(`npm ${res.status} for ${name}`);
  const body = res.text();
  const doc = JSON.parse(body) as NpmPackument;
  const latest = doc["dist-tags"]?.latest ?? null;
  const versions = sortVersions(
    "npm",
    Object.entries(doc.versions ?? {}).map(([version, v]) => ({
      version,
      publishedAt: doc.time?.[version] ?? null,
      deprecated: v.deprecated ?? null,
      isDefault: version === latest,
    })),
  );
  const info: PackageInfo = {
    ecosystem: "npm",
    name,
    versions,
    defaultVersion: latest,
    source: { name: "npm", url, contentHash: sha256(body), checkedAt: now.toISOString() },
  };
  return { info, res };
}

export interface RegistryOptions {
  cache: RegistryCache;
  now?: Date;
}

/**
 * Every published version of a package with publish dates and deprecations, sorted. Uses the cache
 * while fresh; falls back to the ecosystem's own registry, then to a stale cached answer.
 */
export async function getPackageInfo(
  ecosystem: Ecosystem,
  name: string,
  { cache, now = new Date() }: RegistryOptions,
): Promise<PackageInfo | null> {
  const previous = await cache.get(ecosystem, name);
  if (previous && isFresh(previous, now)) return previous.data as PackageInfo;

  const store = async (info: PackageInfo, etag: string | null = null, lastModified: string | null = null) => {
    await cache.put(ecosystem, name, {
      etag,
      lastModified,
      bodyHash: info.source.contentHash,
      data: info,
      fetchedAt: now.toISOString(),
    });
    return info;
  };

  let depsDevError: unknown = null;
  try {
    const info = await fromDepsDev(ecosystem, name, now);
    // deps.dev can lag a brand-new package by up to an hour (FAQ); the registry decides then.
    if (info && info.versions.length > 0) return store(info);
  } catch (error) {
    depsDevError = error;
  }
  if (ecosystem === "npm") {
    try {
      const { info, res } = await fromNpm(name, previous, now);
      if (info) return store(info, res.headers.get("etag"), res.headers.get("last-modified"));
      return null;
    } catch (error) {
      if (previous) return previous.data as PackageInfo;
      throw error;
    }
  }
  if (previous) return previous.data as PackageInfo;
  if (depsDevError) throw depsDevError;
  return null;
}

/** npm `/<name>/<version>`: repository, types, tarball + integrity, peers. Cached per version. */
export async function getNpmVersion(
  name: string,
  version: string,
  { cache, now = new Date() }: RegistryOptions,
): Promise<NpmVersionDetail | null> {
  const key = `${name}@${version}`;
  const previous = await cache.get("npm", key);
  if (previous && isFresh(previous, now)) return previous.data as NpmVersionDetail;
  const url = npmUrl(name, version);
  const res = await guardedFetch(url, {
    allowHosts: [REGISTRY.hosts.npm],
    headers: { accept: "application/json" },
    etag: previous?.etag,
    lastModified: previous?.lastModified,
  });
  if (res.status === 304 && previous) {
    await cache.put("npm", key, { ...previous, fetchedAt: now.toISOString() });
    return previous.data as NpmVersionDetail;
  }
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`npm ${res.status} for ${key}`);
  const body = res.text();
  // biome-ignore lint/suspicious/noExplicitAny: registry JSON, narrowed field by field below
  const doc = JSON.parse(body) as any;
  const repo = doc.repository;
  const detail: NpmVersionDetail = {
    name: doc.name,
    version: doc.version,
    repository:
      typeof repo === "string"
        ? { url: repo }
        : repo?.url
          ? { url: String(repo.url), ...(repo.directory ? { directory: String(repo.directory) } : {}) }
          : null,
    types: doc.types ?? doc.typings ?? null,
    main: doc.main ?? null,
    exports: doc.exports ?? null,
    type: doc.type ?? null,
    dist: {
      tarball: doc.dist.tarball,
      integrity: doc.dist.integrity ?? null,
      shasum: doc.dist.shasum,
      unpackedSize: doc.dist.unpackedSize ?? null,
    },
    dependencies: doc.dependencies ?? {},
    peerDependencies: doc.peerDependencies ?? {},
    peerDependenciesMeta: doc.peerDependenciesMeta ?? {},
    optionalDependencies: doc.optionalDependencies ?? {},
    engines: doc.engines ?? {},
    deprecated: typeof doc.deprecated === "string" ? doc.deprecated : null,
    source: { url, contentHash: sha256(body), checkedAt: now.toISOString() },
  };
  await cache.put("npm", key, {
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    bodyHash: detail.source.contentHash,
    data: detail,
    fetchedAt: now.toISOString(),
  });
  return detail;
}
