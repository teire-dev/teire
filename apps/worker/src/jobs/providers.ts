import { and, changes, type Database, eq, inArray, providerSources, providers } from "@teire/db";
import {
  ingestProvider,
  type PageReader,
  type PreviousFetch,
  type ProviderRecord,
} from "@teire/engine/catalog";
import { CATALOG } from "@teire/engine/constants";
import type { ChangeV2 } from "@teire/engine/contract";
import { createTokenFactory, fetchModelPrices, tokenFactoryConfigFromEnv } from "@teire/engine/llm";
import type { ProviderChanges } from "@teire/engine/pipeline";
import { cachedExtraction } from "../caches";
import { changeHash, recordLlmCall, upsertChange } from "../store";

/**
 * Nemotron for providers found by discovery (no hand-written reader): built on first use, with every
 * reading cached per (model, prompt) in `extraction_cache`, so a page is paid for once.
 */
let reader: Promise<PageReader> | null = null;
export function pageReader(db: Database): Promise<PageReader> {
  reader ??= (async () => ({
    tf: createTokenFactory(tokenFactoryConfigFromEnv()),
    prices: await fetchModelPrices().catch(() => undefined),
    cached: (model, promptHash, compute) => cachedExtraction(db, model, promptHash, compute),
  }))();
  return reader;
}

/**
 * Provider change sources, read on demand (D82): only when a scanned repo talks to the provider (its
 * SDK is installed or its API host is in the code), and at most once per freshness window, shared by
 * every repo that uses the same provider. Pages that did not change answer 304 and cost nothing.
 * Nothing is read on a schedule, and a provider no repo uses is never read.
 */
async function refresh(db: Database, provider: ProviderRecord): Promise<number> {
  const known = await db
    .select()
    .from(providerSources)
    .where(eq(providerSources.providerSlug, provider.slug));
  const now = Date.now();
  // Only the sources the provider lists now: a re-discovered provider may point at other pages.
  const current = known.filter((k) => provider.sources.some((s) => s.url === k.url));
  const fresh =
    provider.sources.every((s) => known.some((k) => k.url === s.url)) &&
    current.every(
      (k) => k.status === "ok" && k.lastCheckedAt && now - k.lastCheckedAt.getTime() < CATALOG.freshForMs,
    );
  if (fresh) return 0;

  await db
    .insert(providers)
    .values({ slug: provider.slug, name: provider.name, record: provider })
    .onConflictDoUpdate({ target: providers.slug, set: { name: provider.name, record: provider } });
  const previous = new Map<string, PreviousFetch>(
    known.map((s) => [s.url, { etag: s.etag, lastModified: s.lastModified, contentHash: s.lastHash }]),
  );
  const discovered = provider.sources.some((s) => s.adapter === "discovered");
  const run = await ingestProvider(provider, {
    previous,
    ...(discovered ? { reader: await pageReader(db) } : {}),
  });
  const kinds = new Map(provider.sources.map((s) => [s.url, s.kind]));
  for (const o of run.outcomes) {
    const ok = o.status !== "failed";
    await db
      .insert(providerSources)
      .values({
        providerSlug: provider.slug,
        kind: kinds.get(o.url) ?? "linked",
        url: o.url,
        status: ok ? "ok" : "failing",
        etag: o.etag ?? null,
        lastModified: o.lastModified ?? null,
        lastHash: o.contentHash ?? null,
        lastCheckedAt: new Date(o.checkedAt),
        lastOkAt: ok ? new Date(o.checkedAt) : null,
        error: o.error ?? null,
      })
      .onConflictDoUpdate({
        target: providerSources.url,
        set: {
          status: ok ? "ok" : "failing",
          lastCheckedAt: new Date(o.checkedAt),
          error: o.error ?? null,
          // Keep the last good validators when a fetch fails or the page is unchanged.
          ...(o.status === "changed"
            ? { etag: o.etag ?? null, lastModified: o.lastModified ?? null, lastHash: o.contentHash ?? null }
            : {}),
          ...(ok ? { lastOkAt: new Date(o.checkedAt) } : {}),
        },
      });
  }
  const stored = new Map(
    (
      await db
        .select({ id: changes.id, hash: changes.contentHash })
        .from(changes)
        .where(eq(changes.providerSlug, provider.slug))
    ).map((r) => [r.id, r.hash]),
  );
  let written = 0;
  for (const record of run.records) {
    if (stored.get(record.id) === changeHash(record)) continue;
    await upsertChange(db, record);
    written++;
  }
  for (const r of run.rejected) console.error(`[providers] ${provider.slug}: ${r.id} rejected: ${r.error}`);
  for (const d of run.dropped)
    console.log(`[providers] ${provider.slug}: dropped "${d.subject}": ${d.reason}`);
  // Every model reading is on the books (spend, the daily budget), even outside a run.
  for (const r of run.receipts)
    if (!r.cached)
      await recordLlmCall(db, {
        runId: null,
        purpose: "provider-page",
        step: provider.slug,
        model: r.model,
        tokensIn: r.tokensIn,
        tokensCached: r.tokensCached,
        tokensOut: r.tokensOut,
        costUsd: r.costUsd.toFixed(6),
        latencyMs: r.ms,
      });
  const cost = run.receipts.reduce((n, r) => n + (r.cached ? 0 : r.costUsd), 0);
  if (run.receipts.length || run.tavily.length)
    console.log(
      `[providers] ${provider.slug}: ${run.receipts.length} page reading(s) by ${run.receipts[0]?.model ?? "-"} ($${cost.toFixed(4)}), Tavily ${run.tavily.reduce((n, u) => n + u.credits, 0)} credit(s)`,
    );
  console.log(
    `[providers] ${provider.slug}: ${run.unchanged ? "unchanged" : `${run.records.length} records`}, ${written} written`,
  );
  return written;
}

/** The worker's reader: refresh what is stale, then return the stored confirmed records. */
export function storedProviderChanges(
  db: Database,
  /** Called with the providers whose pages yielded new or changed records (D95 fan-out). */
  onWritten?: (slugs: string[]) => Promise<void>,
  /** False while model work is blocked (credits, budget): stored records only, no page reading. */
  readPages = true,
): ProviderChanges {
  return async (list) => {
    const changed: string[] = [];
    if (readPages)
      for (const provider of list) if ((await refresh(db, provider)) > 0) changed.push(provider.slug);
    if (changed.length && onWritten) await onWritten(changed);
    if (!list.length) return [];
    const rows = await db
      .select({ record: changes.record })
      .from(changes)
      .where(
        and(
          eq(changes.schemaVersion, 2),
          // Quarantined records too: the assessment says "check by hand" unless a person asks (S16.3).
          inArray(changes.status, ["confirmed", "quarantined"]),
          inArray(
            changes.providerSlug,
            list.map((p) => p.slug),
          ),
        ),
      );
    return rows.map((r) => r.record as ChangeV2);
  };
}
