import { sha256 } from "../catalog/source";
import { REGISTRY } from "../constants";
import {
  asPomArray,
  interpolateWith,
  isBomImport,
  MAVEN_PLUGIN_GROUP,
  type Pom,
  parsePom,
} from "../inventory/jvm";
import { guardedFetch } from "../net/fetch";
import type { RegistryOptions } from "./clients";
import { mavenRepositories } from "./native";

/**
 * A published POM (Codex S18 review #11), from where the repository's own build reads it: a Maven
 * repository it names with a saved credential first (never cached: the answer is that
 * installation's), then the public repository its group lives in, then a repository it names that
 * needs no credential. A released POM never changes, so a public one is cached for good under
 * `pom:group:artifact:version` and a named repository's under its URL too.
 */
export async function fetchPom(
  coordinate: string,
  { cache, now = new Date(), registries = [], discovered = [] }: RegistryOptions,
) {
  const [group, artifact, version] = coordinate.split(":");
  if (!group || !artifact || !version) return null;
  const path = `${group.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}.pom`;
  const read = async (url: string, hosts: string[], headers?: Record<string, string>) => {
    const res = await guardedFetch(`${url.replace(/\/+$/, "")}/${path}`, {
      allowHosts: hosts,
      maxBytes: REGISTRY.maxPomBytes,
      ...(headers ? { headers } : {}),
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`${hosts[0]} ${res.status} for ${coordinate}`);
    return res.text();
  };
  const remember = async (key: string, text: string) => {
    await cache.put("maven", key, {
      etag: null,
      lastModified: null,
      bodyHash: sha256(text),
      data: text,
      fetchedAt: now.toISOString(),
    });
    return parsePom(text);
  };
  const authorized = registries.filter((r) => r.ecosystem === "maven");
  for (const repo of authorized) {
    // A credentialed repository that fails stops the read: the public namesake isn't its POM.
    const text = await read(repo.url, [repo.host], { authorization: repo.authorization });
    if (text !== null) return parsePom(text);
  }
  const key = `pom:${coordinate}`;
  const cached = await cache.get("maven", key);
  if (cached) return parsePom(cached.data as string);
  for (const repo of mavenRepositories(group)) {
    const text = await read(repo.url, [...repo.hosts]);
    if (text !== null) return remember(key, text);
  }
  for (const repo of discovered.filter(
    (d) => d.ecosystem === "maven" && !authorized.some((a) => a.url === d.url),
  )) {
    const named = `pom:${repo.url}|${coordinate}`;
    const hit = await cache.get("maven", named);
    if (hit) return parsePom(hit.data as string);
    const text = await read(repo.url, [repo.host]).catch(() => null);
    if (text !== null) return remember(named, text);
  }
  return null;
}

export interface ManagedVersion {
  version: string;
  /** What the repo names that brings it: its parent or the BOM it imports, `group:artifact version`. */
  by: string;
}

export interface RemoteManaged {
  /** The module's properties over its remote parents' (a `${prop}` the repo uses may live there). */
  props: Record<string, string>;
  dependencies: Map<string, ManagedVersion>;
  plugins: Map<string, ManagedVersion>;
  notes: string[];
}

const label = (coordinate: string) => {
  const [g, a, v] = coordinate.split(":");
  return `${g}:${a} ${v}`;
};

/** A POM and its parents outside the repo, nearest first, within the fetch budget. */
async function chainOf(start: string, options: RegistryOptions, budget: { left: number }, notes: string[]) {
  const chain: { coordinate: string; pom: Pom }[] = [];
  let next: string | null = start;
  while (next && chain.length < 10) {
    if (budget.left-- <= 0) {
      notes.push(`stopped reading parent POMs at ${label(next)}: too many POMs`);
      break;
    }
    const pom: Pom | null = await fetchPom(next, options).catch(() => null);
    if (!pom) {
      notes.push(
        `${label(next)}: POM not found in the repository's Maven repositories, Maven Central, Google Maven or the Plugin Portal`,
      );
      break;
    }
    chain.push({ coordinate: next, pom });
    const p: Pom["parent"] = pom.parent;
    next = p?.groupId && p.artifactId && p.version ? `${p.groupId}:${p.artifactId}:${p.version}` : null;
  }
  return chain;
}

/** Properties a chain defines, its top ancestor first so nearer POMs win, then `overrides` over all. */
function chainProps(chain: { pom: Pom }[], overrides: Record<string, string> = {}) {
  const props: Record<string, string> = {};
  for (const { pom } of [...chain].reverse()) {
    for (const [k, v] of Object.entries(pom.properties ?? {})) props[k] = String(v);
    const version = pom.version ?? pom.parent?.version;
    if (version) Object.assign(props, { "project.version": version, version, "pom.version": version });
    if (pom.groupId ?? pom.parent?.groupId)
      props["project.groupId"] = (pom.groupId ?? pom.parent?.groupId) as string;
  }
  return { ...props, ...overrides };
}

/** A BOM's own managed versions, in its own model (an import never sees the importer's properties). */
async function bomManaged(
  coordinate: string,
  options: RegistryOptions,
  budget: { left: number },
  notes: string[],
  depth: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const chain = await chainOf(coordinate, options, budget, notes);
  const props = chainProps(chain);
  const imports: string[] = [];
  for (const { pom } of chain)
    for (const d of asPomArray(pom.dependencyManagement?.dependencies?.dependency)) {
      if (!d.groupId || !d.artifactId || !d.version) continue;
      const g = interpolateWith(props, d.groupId);
      const a = interpolateWith(props, d.artifactId);
      const v = interpolateWith(props, d.version);
      if (isBomImport(d)) imports.push(`${g}:${a}:${v}`);
      else if (!out.has(`${g}:${a}`)) out.set(`${g}:${a}`, v);
    }
  if (depth < 4)
    for (const nested of await Promise.all(
      imports.map((c) => bomManaged(c, options, budget, notes, depth + 1)),
    ))
      for (const [k, v] of nested) if (!out.has(k)) out.set(k, v);
  return out;
}

/**
 * The versions a module's POMs leave to POMs outside the repo (D-28), as Maven builds its model:
 * the remote parent chain is inherited first (its properties under the repo's, which win, so a
 * repo property can override a parent's version; its managed entries under the repo's own), then
 * imported BOMs fill what is still missing, each in its own model, in declaration order.
 */
export async function remoteManaged(
  remote: { parent: string | null; imports: string[]; props: Record<string, string> },
  options: RegistryOptions,
  budget = { left: REGISTRY.maxRemotePoms },
): Promise<RemoteManaged> {
  const notes: string[] = [];
  const dependencies = new Map<string, ManagedVersion>();
  const plugins = new Map<string, ManagedVersion>();
  const chain = remote.parent ? await chainOf(remote.parent, options, budget, notes) : [];
  const props = chainProps(chain, remote.props);
  const parentLabel = remote.parent ? label(remote.parent) : "";
  const imports: { coordinate: string; by: string }[] = remote.imports.map((c) => ({
    coordinate: c,
    by: label(c),
  }));
  for (const { pom } of chain) {
    for (const d of asPomArray(pom.dependencyManagement?.dependencies?.dependency)) {
      if (!d.groupId || !d.artifactId || !d.version) continue;
      const g = interpolateWith(props, d.groupId);
      const a = interpolateWith(props, d.artifactId);
      const v = interpolateWith(props, d.version);
      if (isBomImport(d)) imports.push({ coordinate: `${g}:${a}:${v}`, by: parentLabel });
      else if (!dependencies.has(`${g}:${a}`)) dependencies.set(`${g}:${a}`, { version: v, by: parentLabel });
    }
    // Plugin versions a parent sets in pluginManagement or in its own build plugins (S18 review C7).
    for (const pl of [
      ...asPomArray(pom.build?.pluginManagement?.plugins?.plugin),
      ...asPomArray(pom.build?.plugins?.plugin),
    ]) {
      if (!pl.artifactId || !pl.version) continue;
      const key = `${interpolateWith(props, pl.groupId ?? MAVEN_PLUGIN_GROUP)}:${interpolateWith(props, pl.artifactId)}`;
      if (!plugins.has(key))
        plugins.set(key, { version: interpolateWith(props, pl.version), by: parentLabel });
    }
  }
  const boms = await Promise.all(imports.map((i) => bomManaged(i.coordinate, options, budget, notes, 0)));
  boms.forEach((managed, i) => {
    for (const [k, v] of managed)
      if (!dependencies.has(k)) dependencies.set(k, { version: v, by: imports[i]?.by ?? "" });
  });
  return { props, dependencies, plugins, notes };
}
