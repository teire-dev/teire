import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256 } from "../catalog/source";
import { DISCOVERY } from "../constants";
import type { DependencyInstance, Ecosystem } from "../contract";
import type { RegistryOptions } from "../registry/clients";
import { fetchNpmPackage } from "../surface/npm-package";
import { fetchPypiWheel } from "../surface/pypi";
import { isApiEndpoint } from "./domains";
import { fetchSdkSource, SOURCE_FILE } from "./sdk-sources";

/**
 * What an installed package says about the API it calls (plan S04, D82): an SDK ships its default base
 * URL in its own code (`groq-sdk` → `https://api.groq.com`, `cohere-ai` → `https://api.cohere.com/v2`,
 * checked on the published packages 2026-10-25), and its metadata names its homepage, docs and
 * repository. Read from the exact published version the lockfile resolves, never executed, and
 * cached per version (published files never change).
 */
export interface SdkProfile {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** API hosts in the package's code, most frequent first. */
  hosts: { host: string; count: number }[];
  /** Homepage, documentation and repository links from the package's own metadata. */
  links: string[];
  filesRead: number;
}

const URL_LITERAL = /["'`](https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^"'`\s<>]*)?)["'`]/g;
const CODE_FILE = { npm: /\.(?:[cm]?js)$/, pypi: /\.py$/ } as const;
const SKIP = /(?:^|\/)(?:tests?|__tests__|examples?|docs?|node_modules|\.bin|testdata|benches|src\/test)\//;

function* walk(dir: string, root = dir): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir) yield* walk(path, root);
    else yield relative(root, path);
  }
}

/** Counts the API hosts named by string literals in a package's code files. */
export function apiHostsIn(dir: string, ecosystem: "npm" | "pypi") {
  function* texts() {
    for (const file of walk(dir)) {
      if (!CODE_FILE[ecosystem].test(file) || file.endsWith(".min.js")) continue;
      try {
        yield { path: file, text: readFileSync(join(dir, file), "utf8") };
      } catch {}
    }
  }
  return apiHostsInTexts(texts());
}

/** The same count over source files already in hand (an SDK read from its registry archive). */
export function apiHostsInTexts(sources: Iterable<{ path: string; text: string }>) {
  const counts = new Map<string, number>();
  let files = 0;
  let bytes = 0;
  for (const { path, text } of sources) {
    if (SKIP.test(path)) continue;
    if (files >= DISCOVERY.sdkMaxFiles || bytes >= DISCOVERY.sdkMaxBytes) break;
    files++;
    bytes += text.length;
    for (const m of text.matchAll(URL_LITERAL)) {
      let url: URL;
      try {
        url = new URL(m[1] ?? "");
      } catch {
        continue;
      }
      if (!isApiEndpoint(url.hostname, url.pathname)) continue;
      counts.set(url.hostname, (counts.get(url.hostname) ?? 0) + 1);
    }
  }
  const hosts = [...counts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  return { hosts, files };
}

function npmLinks(dir: string) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      homepage?: string;
      repository?: string | { url?: string };
      bugs?: string | { url?: string };
    };
    const repo = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
    return [manifest.homepage, repo].filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

/** `Home-page:` and `Project-URL: Documentation, https://…` lines of the wheel's METADATA. */
function pypiLinks(dir: string) {
  const info = (() => {
    try {
      return readdirSync(dir).find((n) => n.endsWith(".dist-info"));
    } catch {
      return undefined;
    }
  })();
  if (!info) return [];
  let text: string;
  try {
    text = readFileSync(join(dir, info, "METADATA"), "utf8");
  } catch {
    return [];
  }
  const links: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) break; // headers end at the first blank line; the description follows
    const home = /^Home-page:\s*(\S+)/i.exec(line);
    if (home?.[1]) links.push(home[1]);
    const project = /^Project-URL:\s*[^,]+,\s*(\S+)/i.exec(line);
    if (project?.[1]) links.push(project[1]);
  }
  return links;
}

export async function sdkProfile(
  instance: Pick<DependencyInstance, "ecosystem" | "name" | "version">,
  options: RegistryOptions & { cacheDir?: string },
): Promise<SdkProfile | null> {
  const { ecosystem, name, version } = instance;
  if (!version) return null;
  const key = `${ecosystem}:${name}@${version}`;
  const cached = await options.cache.get("sdk-profile", key);
  if (cached) return cached.data as SdkProfile | null;
  let profile: SdkProfile;
  try {
    if (ecosystem === "npm" || ecosystem === "pypi") {
      const dir =
        ecosystem === "npm"
          ? (await fetchNpmPackage(name, version, options)).dir
          : (await fetchPypiWheel(name, version, options)).dir;
      const { hosts, files } = apiHostsIn(dir, ecosystem);
      profile = {
        ecosystem,
        name,
        version,
        hosts: hosts.slice(0, 8),
        links: ecosystem === "npm" ? npmLinks(dir) : pypiLinks(dir),
        filesRead: files,
      };
    } else {
      const source = await fetchSdkSource(ecosystem, name, version);
      if (!source) return null;
      const { hosts, files } = apiHostsInTexts(
        source.files.filter((f) => SOURCE_FILE[ecosystem].test(f.path)),
      );
      profile = { ecosystem, name, version, hosts: hosts.slice(0, 8), links: source.links, filesRead: files };
    }
  } catch {
    // A package Teire cannot read now (no wheel, a network error) says nothing about an API; the next scan tries again.
    return null;
  }
  await options.cache.put("sdk-profile", key, {
    etag: null,
    lastModified: null,
    bodyHash: sha256(JSON.stringify(profile)),
    data: profile,
    fetchedAt: new Date().toISOString(),
  });
  return profile;
}
