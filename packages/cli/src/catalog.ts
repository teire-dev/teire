import type { ProviderRecord } from "@teire/engine/catalog";
import type { ChangeV2 } from "@teire/engine/contract";
import type { ProviderChanges } from "@teire/engine/pipeline";
import type { RegistryCache } from "@teire/engine/registry";

/**
 * Teire's public catalog (card C10): confirmed, public change records the service read from each
 * provider's pages behind its quote gate, and the providers it reads. The CLI and the MCP server
 * read it; they never need a model key. `TEIRE_URL` points at another deployment.
 */
export const DEFAULT_URL = "https://teire.vercel.app";

export function catalogUrl() {
  return (process.env.TEIRE_URL ?? DEFAULT_URL).replace(/\/$/, "");
}

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "teire-cli" },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface ChangeFilters {
  provider?: string;
  ecosystem?: string;
  kind?: string;
  subject?: string;
}

export async function listChanges(base: string, filters: ChangeFilters = {}) {
  const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]);
  const path = `${base}/api/catalog/changes${q.size ? `?${q}` : ""}`;
  return (await getJson<{ changes: ChangeV2[] }>(path))?.changes ?? [];
}

export async function getChange(base: string, id: string) {
  return getJson<ChangeV2>(`${base}/api/catalog/changes/${id.split("/").map(encodeURIComponent).join("/")}`);
}

export async function listProviders(base: string) {
  return (await getJson<{ providers: ProviderRecord[] }>(`${base}/api/catalog/providers`))?.providers ?? [];
}

/** The engine's provider-change source, answered from the public catalog by provider slug. */
export function catalogChanges(base: string): ProviderChanges {
  return async (providers) => {
    if (!providers.length) return [];
    return listChanges(base, { provider: providers.map((p) => p.slug).join(",") });
  };
}

/**
 * Provider discovery answered by the service: an API host the code calls resolves to the provider
 * the service already discovered for that domain, as the worker's own discovery cache would. A
 * domain the service has not read stays unread here (`unread` collects it), never searched locally.
 */
export function catalogDiscovery(base: string, inner: RegistryCache) {
  const unread = new Set<string>();
  let known: Promise<ProviderRecord[]> | null = null;
  const cache: RegistryCache = {
    async get(scope, key) {
      if (scope !== "discovery") return inner.get(scope, key);
      known ??= listProviders(base);
      const record = (await known).find((p) => p.discovery && p.officialDomains.includes(key)) ?? null;
      if (!record) unread.add(key);
      return {
        etag: null,
        lastModified: null,
        bodyHash: "",
        data: { record },
        fetchedAt: new Date().toISOString(),
      };
    },
    put: (scope, key, entry) => inner.put(scope, key, entry),
  };
  return { cache, unread };
}
