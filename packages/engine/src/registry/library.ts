import { REGISTRY } from "../constants";
import type { Ecosystem } from "../contract";
import { guardedFetch } from "../net/fetch";
import type { RegistryOptions } from "./clients";

/** One manifest's own identity: its package name, description, and whether it says it's private. */
export interface ManifestIdentity {
  path: string;
  name: string | null;
  description?: string | null;
  private?: boolean;
}

const normal = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** What the registry says the published package is: npm's `description`, PyPI's `summary`. */
async function publishedDescription(ecosystem: Ecosystem, name: string): Promise<string | null> {
  const read = async (url: string, host: string, pick: (doc: Record<string, unknown>) => unknown) => {
    const res = await guardedFetch(url, {
      allowHosts: [host],
      maxBytes: REGISTRY.maxNativeBytes,
      headers: { accept: "application/json" },
    });
    if (res.status !== 200) return null;
    const value = pick(JSON.parse(res.text()) as Record<string, unknown>);
    return typeof value === "string" ? value : null;
  };
  switch (ecosystem) {
    case "npm":
      return read(
        `https://${REGISTRY.hosts.npm}/${name.replace("/", "%2F")}/latest`,
        REGISTRY.hosts.npm,
        (d) => d.description,
      );
    case "pypi":
      return read(
        `https://${REGISTRY.hosts.pypi}/pypi/${encodeURIComponent(name)}/json`,
        REGISTRY.hosts.pypi,
        (d) => (d.info as Record<string, unknown> | undefined)?.summary,
      );
    default:
      return null;
  }
}

/**
 * Which of a project's manifests are published libraries (S18.5), the way Dependabot's `auto`
 * strategy decides. npm and PyPI: a package that isn't private and whose registry description is
 * its own (an app named `api` or `core` shares a name with someone's library, not its
 * description: S18 review C1). RubyGems: every gemspec, whose requirements Bundler's updater
 * always widens. Their runtime ranges widen; an app's bump. `upgrades.versioning` can say `widen`
 * or `increase` for all.
 */
export async function widenedManifests(
  ecosystem: Ecosystem,
  manifests: ManifestIdentity[],
  options: RegistryOptions,
): Promise<string[]> {
  if (options.versioning === "increase") return [];
  if (options.versioning === "widen" || ecosystem === "rubygems") return manifests.map((m) => m.path);
  const out: string[] = [];
  for (const m of manifests) {
    if (!m.name || m.private || !m.description?.trim()) continue;
    const published = await publishedDescription(ecosystem, m.name).catch(() => null);
    if (published && normal(published) === normal(m.description)) out.push(m.path);
  }
  return out;
}
