import { RUBY } from "../constants";
import { guardedFetch } from "../net/fetch";
import { rubygemsScheme } from "./versions";

/**
 * RubyGems.org's own API (plan S07, research ruby.md Job 2): what deps.dev does not carry. One
 * `/api/v1/versions/<gem>.json` call lists every version (one entry per platform) with the Ruby it
 * requires and the gemspec's links; `/api/v2/…/versions/<v>.json` gives one version's runtime
 * dependencies and sha256. A yanked version is simply absent (no reason is published).
 */
export interface GemVersion {
  number: string;
  platform: string;
  createdAt: string | null;
  /** `required_ruby_version`, e.g. ">= 2.6". */
  rubyVersion: string | null;
  prerelease: boolean;
  links: { changelog?: string; source?: string; homepage?: string };
}

interface ApiVersion {
  number: string;
  platform?: string;
  created_at?: string;
  ruby_version?: string | null;
  prerelease?: boolean;
  metadata?: Record<string, string>;
}

const memo = new Map<string, { at: number; value: Promise<GemVersion[]> }>();

export function gemVersions(name: string): Promise<GemVersion[]> {
  const hit = memo.get(name);
  if (hit && Date.now() - hit.at < RUBY.registryMemoMs) return hit.value;
  const value = (async () => {
    const res = await guardedFetch(`https://rubygems.org/api/v1/versions/${encodeURIComponent(name)}.json`, {
      allowHosts: ["rubygems.org"],
      maxBytes: RUBY.maxVersionListBytes,
    });
    if (res.status === 404) return [];
    if (res.status !== 200) throw new Error(`rubygems.org ${res.status} for ${name}`);
    return res.json<ApiVersion[]>().map((v) => ({
      number: v.number,
      platform: v.platform ?? "ruby",
      createdAt: v.created_at ?? null,
      rubyVersion: v.ruby_version && v.ruby_version !== ">= 0" ? v.ruby_version : null,
      prerelease: v.prerelease === true,
      links: {
        ...(v.metadata?.changelog_uri ? { changelog: v.metadata.changelog_uri } : {}),
        ...(v.metadata?.source_code_uri ? { source: v.metadata.source_code_uri } : {}),
        ...(v.metadata?.homepage_uri ? { homepage: v.metadata.homepage_uri } : {}),
      },
    }));
  })();
  memo.set(name, { at: Date.now(), value });
  value.catch(() => memo.delete(name));
  return value;
}

/** Why a version cannot run on the project's Ruby (its `required_ruby_version` excludes it), or null. */
export function requiresOtherRuby(versions: GemVersion[], version: string, ruby: string | null) {
  if (!ruby) return null;
  const v =
    versions.find((x) => x.number === version && x.platform === "ruby") ??
    versions.find((x) => x.number === version);
  if (!v?.rubyVersion) return null;
  try {
    return rubygemsScheme.satisfies(ruby, v.rubyVersion)
      ? null
      : `requires Ruby ${v.rubyVersion} (project: ${ruby})`;
  } catch {
    return null;
  }
}

export interface GemDetail {
  sha: string | null;
  runtime: { name: string; requirements: string }[];
}

/** One version's sha256 and runtime dependencies (`/api/v2`). */
export async function gemVersionDetail(name: string, version: string): Promise<GemDetail | null> {
  const res = await guardedFetch(
    `https://rubygems.org/api/v2/rubygems/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}.json`,
    { allowHosts: ["rubygems.org"] },
  ).catch(() => null);
  if (res?.status !== 200) return null;
  const doc = res.json<{
    sha?: string;
    dependencies?: { runtime?: { name: string; requirements: string }[] };
  }>();
  return { sha: doc.sha ?? null, runtime: doc.dependencies?.runtime ?? [] };
}
