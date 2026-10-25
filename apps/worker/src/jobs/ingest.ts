import { and, changes, type Database, eq, lt, providerSources, providers } from "@teire/db";
import {
  changeRecord,
  ingestProvider,
  PROVIDERS,
  type PreviousFetch,
  toChangeV2,
} from "@teire/engine/catalog";
import { changeHash, upsertChange } from "../store";

export interface IngestSummary {
  provider: string;
  records: number;
  written: number;
  failed: number;
  unchanged: boolean;
}

/**
 * Reads every provider, stores fetch state per URL (for conditional GETs next time) and upserts
 * changed records. Returns how many records changed so the caller can refresh the website.
 */
export async function ingestAll(db: Database): Promise<IngestSummary[]> {
  const known = await db.select().from(providerSources);
  const previous = new Map<string, PreviousFetch>(
    known.map((s) => [s.url, { etag: s.etag, lastModified: s.lastModified, contentHash: s.lastHash }]),
  );
  const summaries: IngestSummary[] = [];

  for (const provider of PROVIDERS) {
    await db
      .insert(providers)
      .values({ slug: provider.slug, name: provider.name, record: provider })
      .onConflictDoUpdate({ target: providers.slug, set: { name: provider.name, record: provider } });

    // Records stored by an older reader (schema v1) are re-read in full: an unchanged page would
    // otherwise keep them as they are forever.
    const [stale] = await db
      .select({ id: changes.id })
      .from(changes)
      .where(and(eq(changes.providerSlug, provider.slug), lt(changes.schemaVersion, 2)))
      .limit(1);
    const run = await ingestProvider(provider, stale ? {} : { previous });
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
              ? {
                  etag: o.etag ?? null,
                  lastModified: o.lastModified ?? null,
                  lastHash: o.contentHash ?? null,
                }
              : {}),
            ...(ok ? { lastOkAt: new Date(o.checkedAt) } : {}),
          },
        });
    }

    // Contract v2 records (S04); an unchanged record (same content hash) writes nothing.
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
    for (const r of run.rejected) console.error(`[ingest] ${provider.slug}: ${r.id} rejected: ${r.error}`);
    // History the provider no longer lists stays, converted in place (it was gated when written).
    if (stale && !run.unchanged) {
      const leftovers = await db
        .select({ record: changes.record })
        .from(changes)
        .where(and(eq(changes.providerSlug, provider.slug), lt(changes.schemaVersion, 2)));
      for (const { record } of leftovers) {
        const parsed = changeRecord.safeParse(record);
        if (!parsed.success) continue;
        await upsertChange(db, toChangeV2(parsed.data, provider));
        written++;
      }
    }

    summaries.push({
      provider: provider.slug,
      records: run.records.length,
      written,
      failed: run.outcomes.filter((o) => o.status === "failed").length,
      unchanged: run.unchanged,
    });
  }
  return summaries;
}

export async function catalogIsEmpty(db: Database) {
  const [row] = await db
    .select({ id: changes.id })
    .from(changes)
    .where(eq(changes.status, "confirmed"))
    .limit(1);
  return !row;
}
