import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DISCOVERY, JVM } from "../constants";
import { extractTarGz } from "../inventory/archive";
import { readZip } from "../inventory/zip";
import { guardedFetch } from "../net/fetch";
import { fetchGemLib } from "../surface/ruby";

/**
 * An SDK's published source in Go, Cargo, RubyGems and Maven (plan S16.1, `discover/sdk.ts`): the
 * exact version the lockfile resolves, from each registry's own archive, read as text and never
 * built or run (D88). With it, the links the package's own metadata names (homepage, docs, repo).
 */
export type SourceEcosystem = "go" | "cargo" | "rubygems" | "maven";

export interface SdkSource {
  files: { path: string; text: string }[];
  links: string[];
}

export const SOURCE_FILE: Record<SourceEcosystem, RegExp> = {
  go: /(?<!_test)\.go$/,
  cargo: /\.rs$/,
  rubygems: /\.rb$/,
  maven: /\.(?:java|kt)$/,
};

/** Go's module path escaping for the proxy: each capital letter becomes `!` and its lower case. */
export function escapeModulePath(path: string) {
  return path.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

const fetchArchive = (url: string, host: string) =>
  guardedFetch(url, { allowHosts: [host], maxBytes: DISCOVERY.sdkMaxBytes, timeoutMs: 120_000 });

async function textsUnder(dir: string, keep: RegExp) {
  const out: { path: string; text: string }[] = [];
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    for (const name of await readdir(d).catch(() => [] as string[])) {
      if (out.length >= DISCOVERY.sdkMaxFiles || bytes >= DISCOVERY.sdkMaxBytes) return;
      const path = join(d, name);
      const info = await stat(path).catch(() => null);
      if (info?.isDirectory()) await walk(path);
      else if (info && keep.test(name)) {
        const text = await readFile(path, "utf8").catch(() => "");
        bytes += text.length;
        out.push({ path: relative(dir, path), text });
      }
    }
  };
  await walk(dir);
  return out;
}

async function goSource(module: string, version: string): Promise<SdkSource | null> {
  const res = await fetchArchive(
    `https://proxy.golang.org/${escapeModulePath(module)}/@v/${version}.zip`,
    "proxy.golang.org",
  );
  if (res.status !== 200) return null;
  // Entries are `module@version/...`, and the module path has slashes of its own.
  const prefix = `@${version}/`;
  const files = [...readZip(res.body, (n) => SOURCE_FILE.go.test(n)).entries()].map(([path, b]) => ({
    path: path.includes(prefix) ? path.slice(path.indexOf(prefix) + prefix.length) : path,
    text: b.toString("utf8"),
  }));
  // A module path names its repository (github.com/sashabaranov/go-openai) or a vanity host.
  return { files, links: [`https://${module.split("/").slice(0, 3).join("/")}`] };
}

async function cargoSource(name: string, version: string): Promise<SdkSource | null> {
  const res = await fetchArchive(
    `https://static.crates.io/crates/${encodeURIComponent(name)}/${encodeURIComponent(name)}-${encodeURIComponent(version)}.crate`,
    "static.crates.io",
  );
  if (res.status !== 200) return null;
  const dir = await mkdtemp(join(tmpdir(), "teire-crate-"));
  try {
    await extractTarGz(res.body, dir, { stripComponents: 1 });
    const manifest = await readFile(join(dir, "Cargo.toml"), "utf8").catch(() => "");
    const links = [...manifest.matchAll(/^\s*(?:homepage|documentation|repository)\s*=\s*"([^"]+)"/gm)].map(
      (m) => m[1] as string,
    );
    return { files: await textsUnder(dir, SOURCE_FILE.cargo), links };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function gemSource(name: string, version: string): Promise<SdkSource | null> {
  const dir = await mkdtemp(join(tmpdir(), "teire-gem-sdk-"));
  try {
    const lib = await fetchGemLib(name, version, dir);
    const meta = await guardedFetch(
      `https://rubygems.org/api/v2/rubygems/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}.json`,
      { allowHosts: ["rubygems.org"] },
    ).catch(() => null);
    const doc =
      meta?.status === 200
        ? meta.json<{ homepage_uri?: string; documentation_uri?: string; source_code_uri?: string }>()
        : {};
    const links = [doc.homepage_uri, doc.documentation_uri, doc.source_code_uri].filter(
      (l): l is string => typeof l === "string" && l.length > 0,
    );
    return { files: await textsUnder(lib, SOURCE_FILE.rubygems), links };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function mavenSource(name: string, version: string): Promise<SdkSource | null> {
  const [group, artifact] = name.split(":") as [string, string];
  const path = `${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}`;
  for (const base of JVM.mavenMirrors) {
    const host = new URL(base).hostname;
    const jar = await fetchArchive(`${base}/${path}-sources.jar`, host).catch(() => null);
    // A miss at one mirror tries the next (review R9); only every mirror missing means no sources.
    if (jar?.status !== 200) continue;
    const pom = await guardedFetch(`${base}/${path}.pom`, { allowHosts: [host] }).catch(() => null);
    const xml = pom?.status === 200 ? Buffer.from(pom.body).toString("utf8") : "";
    // The project's own <url> and its <scm><url>, not a parent's or a dependency's.
    const project = xml.replace(
      /<(parent|dependencies|dependencyManagement|build|profiles)>[\s\S]*?<\/\1>/g,
      "",
    );
    const links = [...project.matchAll(/<url>\s*(https?:\/\/[^<\s]+)\s*<\/url>/g)].map((m) => m[1] as string);
    const files = [...readZip(jar.body, (n) => SOURCE_FILE.maven.test(n)).entries()].map(([p, b]) => ({
      path: p,
      text: b.toString("utf8"),
    }));
    return { files, links };
  }
  return null;
}

export function fetchSdkSource(
  ecosystem: SourceEcosystem,
  name: string,
  version: string,
): Promise<SdkSource | null> {
  if (ecosystem === "go") return goSource(name, version);
  if (ecosystem === "cargo") return cargoSource(name, version);
  if (ecosystem === "rubygems") return gemSource(name, version);
  return mavenSource(name, version);
}
