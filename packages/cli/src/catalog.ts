import type { PageReader, ProviderRecord } from "@teire/engine/catalog";
import type { ChangeV2 } from "@teire/engine/contract";
import { liveProviderChanges, type ProviderChanges } from "@teire/engine/pipeline";
import { PROVIDERS, providerBySlug } from "@teire/engine/providers";
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
  const unread = new Set<string>();
  const undiscovered = new Set<string>();
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
    const missing = list.filter((p) => !served.has(p.slug));
    const readable = missing.filter((p) => local.reader || !needsModel(p));
    for (const p of missing.filter((x) => !readable.includes(x))) unread.add(p.name);
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
      undiscovered.add(key);
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
  const list = (names: Set<string>) =>
    [...names].slice(0, 6).join(", ") + (names.size > 6 ? ` and ${names.size - 6} more` : "");
  // One line each, however many providers or hosts it covers.
  const allNotes = () => [
    ...new Set(notes),
    ...(unread.size
      ? [
          `${list(unread)}: not in the public catalog yet; set TOKENFACTORY_API_KEY to read their pages here with Nemotron`,
        ]
      : []),
    ...(undiscovered.size
      ? [
          `${undiscovered.size} API host${undiscovered.size === 1 ? "" : "s"} the service has not looked up yet (${list(undiscovered)}); set TAVILY_API_KEY to search for their deprecation notices`,
        ]
      : []),
  ];
  return { changes, discovery, notes: allNotes };
}

const live = liveProviderChanges();
const byDate = (a: ChangeV2, b: ChangeV2) => {
  // Upcoming dates first, soonest first; then the ones already past, newest first.
  const today = new Date().toISOString().slice(0, 10);
  const da = a.applicability.effectiveOn?.slice(0, 10) ?? "";
  const db = b.applicability.effectiveOn?.slice(0, 10) ?? "";
  const ua = da >= today;
  const ub = db >= today;
  return ua !== ub ? (ua ? -1 : 1) : ua ? da.localeCompare(db) : db.localeCompare(da);
};

/**
 * `teire changes`: the public catalog first. A provider Teire has a hand-written reader for, whose
 * changes the catalog doesn't hold yet (the service reads a provider only when a scanned repository
 * calls it), is read here from its own pages, through the same readers and quote gate.
 */
export async function changesFor(base: string, filters: ChangeFilters, notes: string[]) {
  const catalog = await listChanges(base, filters).catch((error: unknown) => {
    notes.push(`catalog ${base} unreachable (${error instanceof Error ? error.message : String(error)})`);
    return [] as ChangeV2[];
  });
  if (catalog.length) return catalog;
  if (filters.ecosystem) {
    notes.push(
      `No ${filters.ecosystem} package changes in the public catalog yet. Teire computes a package's changes when it scans a repository that could upgrade it: run \`teire scan\` in one.`,
    );
    return [];
  }
  const slugs = filters.provider
    ? filters.provider.split(",").map((s) => s.trim())
    : PROVIDERS.map((p) => p.slug);
  const readable = slugs.map((slug) => providerBySlug(slug)).filter((p): p is ProviderRecord => Boolean(p));
  for (const slug of slugs.filter((s) => !providerBySlug(s)))
    notes.push(
      `${slug}: not a provider Teire has a reader for (${PROVIDERS.map((p) => p.slug).join(", ")}); others are found when a scan sees their API host`,
    );
  if (!readable.length) return [];
  notes.push(
    `Read just now from ${readable.map((p) => p.name).join(", ")}: the public catalog has none of their changes yet.`,
  );
  return (await live(readable))
    .filter(
      (r) =>
        r.status === "confirmed" &&
        (!filters.kind || r.kind === filters.kind) &&
        (!filters.subject || r.subject.name === filters.subject),
    )
    .sort(byDate);
}

/** One change: from the catalog, or from its provider's own pages when the catalog doesn't hold it yet. */
export async function findChange(base: string, id: string, notes: string[]) {
  const record = await getChange(base, id).catch((error: unknown) => {
    notes.push(`catalog ${base} unreachable (${error instanceof Error ? error.message : String(error)})`);
    return null;
  });
  if (record) return record;
  const provider = PROVIDERS.find((p) => id.startsWith(`${p.slug}-`));
  if (!provider) return null;
  notes.push(
    `Read just now from ${provider.name}'s own pages: the public catalog doesn't hold this change yet.`,
  );
  return (await live([provider])).find((r) => r.id === id) ?? null;
}
