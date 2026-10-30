import { createHash } from "node:crypto";
import { REGISTRY } from "../constants";
import type { DependencyInstance, Ecosystem } from "../contract";
import type { DiscoveredRegistry } from "../credentials";
import { guardedFetch } from "../net/fetch";
import { indexPath } from "./cargo";
import { getPackageInfo, parseNpmPackument, type RegistryOptions } from "./clients";
import { escapeModulePath } from "./go";
import { datedNewest, newestStable, packageInfoOf, parseMavenMetadata } from "./native";
import type { PackageInfo } from "./types";

/** A private registry with the `Authorization` header its saved credential sends (S18.7). */
export interface AuthorizedRegistry extends Omit<DiscoveredRegistry, "file" | "ecosystem"> {
  ecosystem: Ecosystem;
  authorization: string;
  /** The opened credential, for Dependabot's proxy only (it takes tokens and passwords, not headers). */
  secret?: { kind: "token" | "basic"; username: string | null; value: string };
}

/** Go module path patterns (`GOPRIVATE`): `github.com/acme/*` covers `github.com/acme/x/y`. */
function goPrivate(patterns: string[], path: string) {
  return patterns.some((p) => {
    const parts = p.split("/");
    const head = path.split("/").slice(0, parts.length);
    return (
      parts.length === head.length &&
      parts.every((part, i) =>
        new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(
          head[i] ?? "",
        ),
      )
    );
  });
}

/**
 * The private registry a dependency comes from, when one claims it (S18.7): its npm scope, a
 * registry-wide npm or PyPI index replacing the public one, the Cargo registry it names, the Gem
 * source that serves it, a Go module the repo marks private. A claimed package is read there only,
 * never from the public registry, where a same-named package would be someone else's.
 */
export function claimingRegistry(
  ecosystem: Ecosystem,
  instance: Pick<DependencyInstance, "name" | "source" | "sourceRef">,
  registries: AuthorizedRegistry[],
  goPrivatePatterns: string[] = [],
): AuthorizedRegistry | null {
  // A PyPI package is private only once the repo's own index claimed it (applyPrivateClaims).
  if (ecosystem === "pypi" && instance.source !== "private-index") return null;
  return namedRegistry(ecosystem, instance, registries, goPrivatePatterns);
}

/**
 * The registry a repository names for a dependency, credential or not (S18 review S1): its npm scope
 * or a registry-wide npm registry, a PyPI index (one that replaces pypi.org claims every package;
 * an extra one may serve any of them), the Cargo registry or Gem source it names, a Go module its CI
 * marks private.
 */
function namedRegistry<R extends { ecosystem: string; host: string; scope?: string }>(
  ecosystem: Ecosystem,
  instance: Pick<DependencyInstance, "name" | "source" | "sourceRef">,
  registries: R[],
  goPrivatePatterns: string[],
): R | null {
  const own = registries.filter((r) => r.ecosystem === ecosystem);
  if (!own.length) return null;
  switch (ecosystem) {
    case "npm": {
      const scope = instance.name.startsWith("@") ? instance.name.split("/")[0] : null;
      return own.find((r) => r.scope && r.scope === scope) ?? own.find((r) => !r.scope) ?? null;
    }
    case "pypi":
      return own[0] ?? null;
    case "cargo":
      return instance.source === "private-index"
        ? (own.find((r) => r.scope === instance.sourceRef) ?? null)
        : null;
    case "rubygems":
      return instance.source === "private-index"
        ? (own.find((r) => instance.sourceRef?.includes(r.host)) ?? own[0] ?? null)
        : null;
    case "go":
      return goPrivate(goPrivatePatterns, instance.name) ? (own[0] ?? null) : null;
    default:
      return null;
  }
}

/**
 * Marks each dependency a repository's private registry serves (S18 review S1), before any lookup:
 * it is read there with a saved credential, and without one it is not compared, saying which
 * registry, never looked up on the public registry, where a package of the same name would be
 * someone else's.
 */
export function applyPrivateClaims(
  instances: DependencyInstance[],
  ecosystem: Ecosystem,
  options: Pick<RegistryOptions, "discovered" | "goPrivate">,
) {
  for (const i of instances) {
    if (i.source !== "registry" && i.source !== "private-index") continue;
    const named = namedRegistry(ecosystem, i, options.discovered ?? [], options.goPrivate ?? []);
    if (!named) continue;
    i.source = "private-index";
    // Cargo's registry name is how a claim finds its credential; elsewhere the host.
    if (ecosystem !== "cargo" || !i.sourceRef) i.sourceRef = named.host;
  }
}

const memo = new Map<string, Promise<PackageInfo | null>>();

/**
 * A package's versions from a private registry (D-35), in its own protocol: an npm packument, PyPI's
 * JSON simple API (PEP 691/700), a Maven `maven-metadata.xml`, a Cargo sparse index, RubyGems'
 * versions API, a GOPROXY `@v/list`. Fetched with the credential, never cached across scans (a
 * cached answer could reach an installation without that access).
 */
export function fromPrivateRegistry(registry: AuthorizedRegistry, name: string, now = new Date()) {
  // Keyed by the whole credential's hash, never a tail two credentials could share (S18 review S8).
  const key = `${registry.ecosystem}|${registry.url}|${createHash("sha256").update(registry.authorization).digest("hex")}|${name}`;
  const known = memo.get(key);
  if (known) return known;
  const pending = readPrivate(registry, name, now);
  memo.set(key, pending);
  pending.catch(() => memo.delete(key));
  setTimeout(() => memo.delete(key), 10 * 60_000).unref?.();
  return pending;
}

async function readPrivate(
  registry: AuthorizedRegistry,
  name: string,
  now: Date,
): Promise<PackageInfo | null> {
  const base = registry.url.replace(/\/+$/, "");
  const get = (url: string, accept?: string) =>
    guardedFetch(url, {
      allowHosts: [registry.host],
      maxBytes: REGISTRY.maxNativeBytes,
      headers: { authorization: registry.authorization, ...(accept ? { accept } : {}) },
    });
  const source = { name: registry.host, now };
  switch (registry.ecosystem) {
    case "npm": {
      const url = `${base}/${name.startsWith("@") ? name.replace("/", "%2f") : name}`;
      const res = await get(url, "application/json");
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`${registry.host} ${res.status} for ${name}`);
      return parseNpmPackument(name, res.text(), url, now, registry.host);
    }
    case "pypi": {
      const normal = name.toLowerCase().replace(/[-_.]+/g, "-");
      const url = `${base}/${normal}/`;
      const res = await get(url, "application/vnd.pypi.simple.v1+json");
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`${registry.host} ${res.status} for ${name}`);
      const body = res.text();
      const doc = JSON.parse(body) as {
        versions?: string[];
        files?: { filename: string; "upload-time"?: string; yanked?: boolean | string }[];
      };
      const versionOf = (file: string) =>
        new RegExp(`^${normal.replace(/-/g, "[-_.]")}-([^-]+?)(?:-|\\.tar|\\.zip)`, "i").exec(file)?.[1] ??
        null;
      const byVersion = new Map<string, { times: string[]; yanked: (boolean | string)[] }>();
      for (const f of doc.files ?? []) {
        const v = versionOf(f.filename);
        if (!v) continue;
        const entry = byVersion.get(v) ?? { times: [], yanked: [] };
        if (f["upload-time"]) entry.times.push(f["upload-time"]);
        entry.yanked.push(f.yanked ?? false);
        byVersion.set(v, entry);
      }
      const versions = [...new Set([...(doc.versions ?? []), ...byVersion.keys()])].map((version) => {
        const e = byVersion.get(version);
        const yanked =
          e?.yanked.length && e.yanked.every((y) => y !== false)
            ? e.yanked.find((y) => typeof y === "string")
            : undefined;
        return {
          version,
          publishedAt: e?.times.sort()[0] ?? null,
          deprecated:
            e?.yanked.length && e.yanked.every((y) => y !== false)
              ? typeof yanked === "string"
                ? yanked
                : ""
              : null,
          isDefault: false,
        };
      });
      return packageInfoOf("pypi", name, versions, newestStable("pypi", versions), { ...source, url, body });
    }
    case "maven": {
      const [group, artifact] = name.split(":");
      if (!group || !artifact) return null;
      const dir = `${base}/${group.replaceAll(".", "/")}/${artifact}`;
      const res = await get(`${dir}/maven-metadata.xml`);
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`${registry.host} ${res.status} for ${name}`);
      const body = res.text();
      const { versions: listed, release } = parseMavenMetadata(body);
      const versions = await datedNewest("maven", listed, async (v) => {
        const pom = await get(`${dir}/${v}/${artifact}-${v}.pom`);
        const modified = pom.status === 200 ? pom.headers.get("last-modified") : null;
        return modified ? new Date(modified).toISOString() : null;
      });
      return packageInfoOf("maven", name, versions, release, {
        ...source,
        url: `${dir}/maven-metadata.xml`,
        body,
      });
    }
    case "cargo": {
      const url = `${base.replace(/^sparse\+/, "")}/${indexPath(name)}`;
      const res = await get(url);
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`${registry.host} ${res.status} for ${name}`);
      const body = res.text();
      const lines = body
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { vers: string; yanked: boolean; pubtime?: string });
      const versions = lines.map((l) => ({
        version: l.vers,
        publishedAt: l.pubtime ?? null,
        deprecated: l.yanked ? "" : null,
        isDefault: false,
      }));
      return packageInfoOf("cargo", name, versions, newestStable("cargo", versions), {
        ...source,
        url,
        body,
      });
    }
    case "rubygems": {
      const url = `${base}/api/v1/versions/${encodeURIComponent(name)}.json`;
      const res = await get(url, "application/json");
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`${registry.host} ${res.status} for ${name}`);
      const body = res.text();
      const listed = JSON.parse(body) as { number: string; created_at?: string }[];
      const byNumber = new Map<string, string | null>();
      for (const v of listed) {
        const at = v.created_at ?? null;
        const known = byNumber.get(v.number);
        if (known === undefined || (at && (!known || at < known))) byNumber.set(v.number, at);
      }
      const versions = [...byNumber].map(([version, publishedAt]) => ({
        version,
        publishedAt,
        deprecated: null,
        isDefault: false,
      }));
      return packageInfoOf("rubygems", name, versions, newestStable("rubygems", versions), {
        ...source,
        url,
        body,
      });
    }
    case "go": {
      const list = `${base}/${escapeModulePath(name)}/@v`;
      const res = await get(`${list}/list`);
      if (res.status === 404 || res.status === 410) return null;
      if (res.status !== 200) throw new Error(`${registry.host} ${res.status} for ${name}`);
      const body = res.text();
      const versions = await datedNewest(
        "go",
        body
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
        async (v) => {
          const r = await get(`${list}/${encodeURIComponent(v)}.info`);
          return r.status === 200 ? ((JSON.parse(r.text()) as { Time?: string }).Time ?? null) : null;
        },
      );
      return packageInfoOf("go", name, versions, newestStable("go", versions), {
        ...source,
        url: `${list}/list`,
        body,
      });
    }
    default:
      return null;
  }
}

/**
 * A dependency's versions: from the private registry that claims it (S18.7), else deps.dev and the
 * public registries. A Maven repository the repo declares is tried after Central, Google and the
 * Plugin Portal don't have the artifact.
 */
export async function lookupPackage(
  ecosystem: Ecosystem,
  instance: Pick<DependencyInstance, "name" | "source" | "sourceRef">,
  options: RegistryOptions,
): Promise<PackageInfo | null> {
  const registries = options.registries ?? [];
  const claimed = claimingRegistry(ecosystem, instance, registries, options.goPrivate);
  if (claimed) {
    const found = await fromPrivateRegistry(claimed, instance.name, options.now);
    // An extra PyPI index adds to pypi.org: pip takes a package from either.
    if (found || !(ecosystem === "pypi" && claimed.replacesBase === false)) return found;
    return getPackageInfo(ecosystem, instance.name, options);
  }
  // Maven reads the repositories a build declares before Central (S18 review S2): a credentialed
  // private repository answers first, the public ones after.
  if (ecosystem === "maven")
    for (const r of registries.filter((x) => x.ecosystem === "maven")) {
      const found = await fromPrivateRegistry(r, instance.name, options.now).catch(() => null);
      if (found) return found;
    }
  return getPackageInfo(ecosystem, instance.name, options);
}

/** Whether a pipeline can compare this dependency: a public registry's, or a private one Teire can read. */
export function comparable(
  ecosystem: Ecosystem,
  instance: Pick<DependencyInstance, "name" | "source" | "sourceRef">,
  options: Pick<RegistryOptions, "registries" | "goPrivate">,
) {
  return (
    instance.source === "registry" ||
    (instance.source === "private-index" &&
      claimingRegistry(ecosystem, instance, options.registries ?? [], options.goPrivate) !== null)
  );
}
