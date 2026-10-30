import { sha256 } from "../catalog/source";
import { GO, REGISTRY } from "../constants";
import type { Ecosystem } from "../contract";
import { guardedFetch } from "../net/fetch";
import { cratesIndexLines } from "./cargo";
import { escapeModulePath } from "./go";
import { gemVersions } from "./rubygems";
import type { PackageInfo, VersionInfo } from "./types";
import { versionScheme } from "./versions";

/**
 * Each ecosystem's own registry as a version source (S18.2), for what deps.dev doesn't know: a
 * package it hasn't indexed (Google's Maven, Gradle plugins), or one it has no versions for yet.
 * PyPI's JSON API, the crates.io sparse index (`pubtime`, yanks), the Go module proxy, a Maven
 * repository's `maven-metadata.xml` (dates from each recent pom's `Last-Modified`) and RubyGems.org.
 */
export async function fromNativeRegistry(
  ecosystem: Ecosystem,
  name: string,
  now: Date,
): Promise<PackageInfo | null> {
  switch (ecosystem) {
    case "pypi":
      return fromPypi(name, now);
    case "cargo":
      return fromCratesIndex(name, now);
    case "go":
      return fromGoProxy(name, now);
    case "maven":
      return fromMaven(name, now);
    case "rubygems":
      return fromRubygems(name, now);
    default:
      return null;
  }
}

function info(
  ecosystem: Ecosystem,
  name: string,
  versions: VersionInfo[],
  defaultVersion: string | null,
  source: { name: string; url: string; body: string; now: Date },
): PackageInfo | null {
  const scheme = versionScheme(ecosystem);
  const sorted = versions
    .filter((v) => scheme.valid(v.version))
    .sort((a, b) => scheme.compare(a.version, b.version))
    .map((v) => ({ ...v, isDefault: v.version === defaultVersion }));
  if (!sorted.length) return null;
  return {
    ecosystem,
    name,
    versions: sorted,
    defaultVersion: sorted.some((v) => v.isDefault) ? defaultVersion : null,
    source: {
      name: source.name,
      url: source.url,
      contentHash: sha256(source.body),
      checkedAt: source.now.toISOString(),
    },
  };
}

/** The newest non-pre-release, not yanked: what a registry's own "latest" is when it names none. */
function newestStable(ecosystem: Ecosystem, versions: VersionInfo[]) {
  const scheme = versionScheme(ecosystem);
  return (
    versions
      .filter((v) => v.deprecated === null && scheme.valid(v.version) && !scheme.isPrerelease(v.version))
      .sort((a, b) => scheme.compare(b.version, a.version))[0]?.version ?? null
  );
}

interface PypiFile {
  upload_time_iso_8601?: string;
  yanked?: boolean;
  yanked_reason?: string | null;
}

async function fromPypi(name: string, now: Date) {
  const url = `https://${REGISTRY.hosts.pypi}/pypi/${encodeURIComponent(name)}/json`;
  const res = await guardedFetch(url, {
    allowHosts: [REGISTRY.hosts.pypi],
    maxBytes: REGISTRY.maxNativeBytes,
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`PyPI ${res.status} for ${name}`);
  const body = res.text();
  const doc = JSON.parse(body) as { info?: { version?: string }; releases?: Record<string, PypiFile[]> };
  // A release with no files can't be installed; one whose every file is yanked is yanked (PEP 592).
  const versions = Object.entries(doc.releases ?? {}).flatMap(([version, files]) => {
    if (!files.length) return [];
    const times = files.flatMap((f) => (f.upload_time_iso_8601 ? [f.upload_time_iso_8601] : [])).sort();
    const yanked = files.every((f) => f.yanked);
    return [
      {
        version,
        publishedAt: times[0] ?? null,
        deprecated: yanked ? (files.find((f) => f.yanked_reason)?.yanked_reason ?? "") : null,
        isDefault: false,
      },
    ];
  });
  return info("pypi", name, versions, doc.info?.version ?? null, { name: "pypi.org", url, body, now });
}

async function fromCratesIndex(name: string, now: Date) {
  const lines = await cratesIndexLines(name);
  const versions = lines.map((l) => ({
    version: l.vers,
    publishedAt: l.pubtime ?? null,
    deprecated: l.yanked ? "" : null,
    isDefault: false,
  }));
  return info("cargo", name, versions, newestStable("cargo", versions), {
    name: "index.crates.io",
    url: `https://index.crates.io/${name}`,
    body: lines.map((l) => `${l.vers}${l.yanked ? " yanked" : ""}`).join("\n"),
    now,
  });
}

/** Runs `work` over `items`, `limit` at a time. */
async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i] as T);
      }
    }),
  );
  return out;
}

/**
 * Dates for the newest `REGISTRY.nativeDatedVersions` versions only (one request each): what a
 * target can be, and what a cooldown reads. An older version without one is never a target.
 */
async function datedNewest(
  ecosystem: Ecosystem,
  versions: string[],
  dateOf: (version: string) => Promise<string | null>,
): Promise<VersionInfo[]> {
  const scheme = versionScheme(ecosystem);
  const valid = versions.filter((v) => scheme.valid(v)).sort((a, b) => scheme.compare(b, a));
  const recent = valid.slice(0, REGISTRY.nativeDatedVersions);
  const dates = await pooled(recent, REGISTRY.nativeConcurrency, (v) => dateOf(v).catch(() => null));
  return valid.map((version, i) => ({
    version,
    publishedAt: i < recent.length ? (dates[i] ?? null) : null,
    deprecated: null,
    isDefault: false,
  }));
}

async function fromGoProxy(path: string, now: Date) {
  const host = new URL(GO.proxy).hostname;
  const base = `${GO.proxy}/${escapeModulePath(path)}/@v`;
  const res = await guardedFetch(`${base}/list`, { allowHosts: [host] });
  if (res.status === 404 || res.status === 410) return null;
  if (res.status !== 200) throw new Error(`Go proxy ${res.status} for ${path}`);
  const body = res.text();
  const listed = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const versions = await datedNewest("go", listed, async (v) => {
    const r = await guardedFetch(`${base}/${encodeURIComponent(v)}.info`, { allowHosts: [host] });
    return r.status === 200 ? ((JSON.parse(r.text()) as { Time?: string }).Time ?? null) : null;
  });
  const latest = await guardedFetch(`${GO.proxy}/${escapeModulePath(path)}/@latest`, { allowHosts: [host] })
    .then((r) => (r.status === 200 ? ((JSON.parse(r.text()) as { Version?: string }).Version ?? null) : null))
    .catch(() => null);
  return info("go", path, versions, latest, { name: host, url: `${base}/list`, body, now });
}

/**
 * Maven repositories by where a group lives: Google's own (`androidx`, Android, Firebase, Play
 * services) first for its groups, then Central, then the Gradle Plugin Portal (plugin markers).
 */
export function mavenRepositories(group: string) {
  const google = REGISTRY.googleMavenGroups.some((g) => group === g || group.startsWith(`${g}.`));
  const { central, google: googleMaven, pluginPortal } = REGISTRY.maven;
  return google ? [googleMaven, central, pluginPortal] : [central, googleMaven, pluginPortal];
}

/** `<versions><version>…</version>…` and `<release>` from a `maven-metadata.xml`. */
export function parseMavenMetadata(xml: string) {
  const versions = [...xml.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)].map((m) => m[1] as string);
  const release = /<release>\s*([^<\s]+)\s*<\/release>/.exec(xml)?.[1] ?? null;
  return { versions, release };
}

async function fromMaven(coordinate: string, now: Date) {
  const [group, artifact] = coordinate.split(":");
  if (!group || !artifact) return null;
  for (const repo of mavenRepositories(group)) {
    const dir = `${repo.url}/${group.replaceAll(".", "/")}/${artifact}`;
    const res = await guardedFetch(`${dir}/maven-metadata.xml`, {
      allowHosts: [...repo.hosts],
      maxBytes: REGISTRY.maxNativeBytes,
    });
    if (res.status === 404) continue;
    if (res.status !== 200) throw new Error(`${repo.name} ${res.status} for ${coordinate}`);
    const body = res.text();
    const { versions: listed, release } = parseMavenMetadata(body);
    if (!listed.length) continue;
    const versions = await datedNewest("maven", listed, async (v) => {
      const pom = await guardedFetch(`${dir}/${v}/${artifact}-${v}.pom`, {
        allowHosts: [...repo.hosts],
        maxBytes: REGISTRY.maxPomBytes,
      });
      const modified = pom.status === 200 ? pom.headers.get("last-modified") : null;
      return modified ? new Date(modified).toISOString() : null;
    });
    return info("maven", coordinate, versions, release, {
      name: repo.name,
      url: `${dir}/maven-metadata.xml`,
      body,
      now,
    });
  }
  return null;
}

async function fromRubygems(name: string, now: Date) {
  const listed = await gemVersions(name);
  // One entry per platform: a version's date is its first build's.
  const byNumber = new Map<string, VersionInfo>();
  for (const v of listed) {
    const known = byNumber.get(v.number);
    if (!known || (v.createdAt && (!known.publishedAt || v.createdAt < known.publishedAt)))
      byNumber.set(v.number, {
        version: v.number,
        publishedAt: v.createdAt,
        deprecated: null,
        isDefault: false,
      });
  }
  const versions = [...byNumber.values()];
  return info("rubygems", name, versions, newestStable("rubygems", versions), {
    name: "rubygems.org",
    url: `https://rubygems.org/api/v1/versions/${encodeURIComponent(name)}.json`,
    body: versions.map((v) => `${v.version} ${v.publishedAt ?? ""}`).join("\n"),
    now,
  });
}
