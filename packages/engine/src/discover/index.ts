import type { ProviderRecord } from "../catalog/schema";
import { sha256 } from "../catalog/source";
import { DISCOVERY } from "../constants";
import type { DependencyInstance } from "../contract";
import type { RegistryOptions } from "../registry/clients";
import { isApiEndpoint, linkScope, registrableDomain } from "./domains";
import { discoverProvider, type ProviderCandidate } from "./pages";
import { type SdkProfile, sdkProfile } from "./sdk";
import type { TavilyUsage } from "./tavily";

export * from "./domains";
export * from "./page";
export * from "./pages";
export * from "./sdk";
export * from "./tavily";

/**
 * Providers a repo talks to that have no reader (plan S04, D82). Two deterministic signals:
 *  - an API host in a URL literal of the repo's code (`https://api.groq.com/openai/v1`);
 *  - an installed SDK whose own published code calls an API host on a domain its name or its
 *    metadata links share (`groq-sdk` → `api.groq.com`; `next`, which mentions other companies'
 *    APIs, names none of them).
 * Hosts a curated reader already covers are left to it.
 */
export interface ProviderUse {
  provider: ProviderRecord;
  via: string[];
}

/** Hosts and domains the curated readers cover (their API hosts and official domains). */
function coveredBy(known: readonly ProviderRecord[]) {
  const hosts = new Set(known.flatMap((p) => p.detection.baseUrls));
  const domains = new Set(
    known.flatMap((p) =>
      [...p.officialDomains, ...p.detection.baseUrls].map((h) => registrableDomain(h) ?? h),
    ),
  );
  return (host: string) => hosts.has(host) || domains.has(registrableDomain(host) ?? host);
}

/** Letters and digits only: `@mistralai/mistralai` → "mistralaimistralai". */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The SDK is for this host: its name holds the domain's label, or one of its own links is on that domain. */
export function sdkIsFor(profile: Pick<SdkProfile, "name" | "links">, host: string) {
  const domain = registrableDomain(host);
  if (!domain) return false;
  const label = squash(domain.split(".")[0] ?? "");
  if (label.length >= 3 && squash(profile.name).includes(label)) return true;
  return profile.links.some((l) => {
    const scope = linkScope(l);
    return scope !== null && "domain" in scope && scope.domain === domain;
  });
}

async function mapLimited<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

export async function providerCandidates(input: {
  urls: { host: string; path: string }[];
  instances: Pick<DependencyInstance, "ecosystem" | "name" | "version" | "direct" | "scope" | "source">[];
  known: readonly ProviderRecord[];
  options: RegistryOptions & { cacheDir?: string };
}): Promise<ProviderCandidate[]> {
  const covered = coveredBy(input.known);
  const knownSdks = new Set(input.known.flatMap((p) => p.sdks.map((s) => `${s.ecosystem}:${s.name}`)));
  const byDomain = new Map<string, ProviderCandidate>();
  const entry = (domain: string) => {
    const known = byDomain.get(domain);
    if (known) return known;
    const created: ProviderCandidate = { domain, hosts: [], sdks: [], via: [] };
    byDomain.set(domain, created);
    return created;
  };
  for (const { host, path } of input.urls) {
    if (!isApiEndpoint(host, path) || covered(host)) continue;
    const domain = registrableDomain(host);
    if (!domain) continue;
    const c = entry(domain);
    if (!c.hosts.includes(host)) {
      c.hosts.push(host);
      c.via.push(host);
    }
  }
  const packages = input.instances
    .filter(
      (i) =>
        i.direct &&
        i.source === "registry" &&
        (i.ecosystem === "npm" || i.ecosystem === "pypi") &&
        !["dev", "test", "build"].includes(i.scope) &&
        !i.name.startsWith("@types/") &&
        !knownSdks.has(`${i.ecosystem}:${i.name}`),
    )
    .filter((i, n, all) => all.findIndex((x) => x.ecosystem === i.ecosystem && x.name === i.name) === n)
    .slice(0, DISCOVERY.maxSdkPackages);
  const profiles = await mapLimited(packages, DISCOVERY.sdkConcurrency, (i) => sdkProfile(i, input.options));
  for (const profile of profiles) {
    const top = profile?.hosts.find((h) => !covered(h.host) && sdkIsFor(profile, h.host));
    if (!profile || !top) continue;
    const domain = registrableDomain(top.host);
    if (!domain) continue;
    const c = entry(domain);
    if (!c.hosts.includes(top.host)) c.hosts.push(top.host);
    c.sdks.push(profile);
    c.via.push(`${profile.ecosystem}:${profile.name}`);
  }
  return [...byDomain.values()];
}

/**
 * Each candidate's notice pages, from the cache while fresh (one search per provider per week,
 * shared by every repo), otherwise discovered now. A provider with no page found is cached too, so
 * it is not searched again on every scan.
 */
export async function discoverProviders(
  candidates: ProviderCandidate[],
  options: RegistryOptions,
): Promise<{ used: ProviderUse[]; usage: TavilyUsage[]; notes: string[] }> {
  const now = options.now ?? new Date();
  const used: ProviderUse[] = [];
  const usage: TavilyUsage[] = [];
  const notes: string[] = [];
  for (const candidate of candidates) {
    const cached = await options.cache.get("discovery", candidate.domain);
    let record: ProviderRecord | null;
    if (cached && now.getTime() - Date.parse(cached.fetchedAt) < DISCOVERY.freshForMs) {
      record = (cached.data as { record: ProviderRecord | null }).record;
    } else {
      const found = await discoverProvider(candidate, now);
      usage.push(...found.usage);
      if (found.note) notes.push(`${candidate.domain}: ${found.note}`);
      record = found.record;
      if (!found.transient)
        await options.cache.put("discovery", candidate.domain, {
          etag: null,
          lastModified: null,
          bodyHash: sha256(JSON.stringify(record)),
          data: { record },
          fetchedAt: now.toISOString(),
        });
    }
    if (record) used.push({ provider: record, via: candidate.via });
  }
  return { used, usage, notes };
}
