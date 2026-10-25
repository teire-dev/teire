import { and, changes, type Database, eq, inArray, providerSources, providers } from "@teire/db";
import { ingestProvider, type PreviousFetch, type ProviderRecord } from "@teire/engine/catalog";
import { CATALOG } from "@teire/engine/constants";
import type { ChangeV2 } from "@teire/engine/contract";
import type { ProviderChanges } from "@teire/engine/pipeline";
import { changeHash, upsertChange } from "../store";

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
  const fresh =
    provider.sources.every((s) => known.some((k) => k.url === s.url)) &&
    known.every(
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
  console.log(
    `[providers] ${provider.slug}: ${run.unchanged ? "unchanged" : `${run.records.length} records`}, ${written} written`,
  );
  return written;
}

/** The worker's reader: refresh what is stale, then return the stored confirmed records. */
export function storedProviderChanges(db: Database, onWritten?: () => Promise<void>): ProviderChanges {
  return async (list) => {
    let written = 0;
    for (const provider of list) written += await refresh(db, provider);
    if (written && onWritten) await onWritten();
    if (!list.length) return [];
    const rows = await db
      .select({ record: changes.record })
      .from(changes)
      .where(
        and(
          eq(changes.schemaVersion, 2),
          eq(changes.status, "confirmed"),
          inArray(
            changes.providerSlug,
            list.map((p) => p.slug),
          ),
        ),
      );
    return rows.map((r) => r.record as ChangeV2);
  };
}
