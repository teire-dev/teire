import { changes, type Database, eq, providerSources, providers, sql } from "@teire/db";
import {
  type ChangeRecord,
  ingestProvider,
  PROVIDERS,
  type PreviousFetch,
  sha256,
} from "@teire/engine/catalog";

/** Hash of what a record says, ignoring when it was read, so re-reading an unchanged page writes nothing. */
function recordHash(record: ChangeRecord) {
  return sha256(JSON.stringify({ ...record, sources: record.sources.map(({ checkedAt: _, ...s }) => s) }));
}

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

    const run = await ingestProvider(provider, { previous });
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

    let written = 0;
    for (const record of run.records) {
      const contentHash = recordHash(record);
      const rows = await db
        .insert(changes)
        .values({
          id: record.id,
          providerSlug: record.provider,
          kind: record.kind,
          title: record.title,
          deadline: record.effectiveOn ? new Date(`${record.effectiveOn}T00:00:00Z`) : null,
          status: record.status,
          contentHash,
          record,
        })
        .onConflictDoUpdate({
          target: changes.id,
          set: {
            kind: record.kind,
            title: record.title,
            deadline: record.effectiveOn ? new Date(`${record.effectiveOn}T00:00:00Z`) : null,
            status: record.status,
            contentHash,
            record,
          },
          setWhere: sql`${changes.contentHash} <> excluded.content_hash`,
        })
        .returning({ id: changes.id });
      written += rows.length;
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
