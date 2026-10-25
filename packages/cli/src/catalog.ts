import type { PageReader, ProviderRecord } from "@teire/engine/catalog";
import type { ChangeV2 } from "@teire/engine/contract";
import { liveProviderChanges, type ProviderChanges } from "@teire/engine/pipeline";
import type { RegistryCache } from "@teire/engine/registry";

/**
 * Teire's public catalog (card C10): confirmed, public change records the service read from each
 * provider's pages behind its quote gate, and the providers it reads. The CLI and the MCP server
 * read it first; `TEIRE_URL` points at another deployment.
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

const needsModel = (p: ProviderRecord) => p.sources.some((s) => s.adapter === "discovered");

/**
 * Where a local scan's provider changes come from (D82: only providers the repo uses). A provider the
 * service reads is answered from the catalog. One it has not read yet is read here, through the
 * same readers and quote gate: hand-written readers need no model; discovered pages and teire.yml
 * sources need Nemotron (`reader`). An API host the service has not discovered is searched here only
 * with `TAVILY_API_KEY`, as the worker would.
 */
export function remoteCatalog(base: string, local: { cache: RegistryCache; reader?: PageReader }) {
  const notes: string[] = [];
  let known: Promise<ProviderRecord[]> | null = null;
  const providers = () =>
    (known ??= listProviders(base).catch((error: unknown) => {
      notes.push(
        `catalog ${base} unreachable (${error instanceof Error ? error.message : String(error)}); pages read locally`,
      );
      return [];
    }));
  const live = liveProviderChanges(local.reader ? { reader: local.reader } : {});

  const changes: ProviderChanges = async (list) => {
    if (!list.length) return [];
    const served = new Set((await providers()).map((p) => p.slug));
    const fromCatalog = list.filter((p) => served.has(p.slug));
    const unread = list.filter((p) => !served.has(p.slug));
    const readable = unread.filter((p) => local.reader || !needsModel(p));
    for (const p of unread.filter((x) => !readable.includes(x)))
      notes.push(
        `${p.name}: not in the catalog yet; set TOKENFACTORY_API_KEY to read its pages locally with Nemotron`,
      );
    const [a, b] = await Promise.all([
      fromCatalog.length ? listChanges(base, { provider: fromCatalog.map((p) => p.slug).join(",") }) : [],
      readable.length ? live(readable) : [],
    ]);
    return [...a, ...b];
  };

  const discovery: RegistryCache = {
    async get(scope, key) {
      if (scope !== "discovery") return local.cache.get(scope, key);
      const record = (await providers()).find((p) => p.discovery && p.officialDomains.includes(key)) ?? null;
      if (record || process.env.TAVILY_API_KEY)
        return record
          ? {
              etag: null,
              lastModified: null,
              bodyHash: "",
              data: { record },
              fetchedAt: new Date().toISOString(),
            }
          : local.cache.get(scope, key);
      notes.push(
        `${key}: an API host the service has not discovered yet; set TAVILY_API_KEY to search for its notices`,
      );
      return {
        etag: null,
        lastModified: null,
        bodyHash: "",
        data: { record: null },
        fetchedAt: new Date().toISOString(),
      };
    },
    put: (scope, key, entry) => local.cache.put(scope, key, entry),
  };
  return { changes, discovery, notes };
}
