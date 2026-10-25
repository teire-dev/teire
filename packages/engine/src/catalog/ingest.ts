import { CATALOG } from "../constants";
import type { ChangeV2 } from "../contract";
import { fetchDiscoveredPage } from "../discover/page";
import type { TavilyUsage } from "../discover/tavily";
import { plainText } from "../notes/extract";
import { readAnthropic } from "./adapters/anthropic";
import { readDeprecationTables } from "./adapters/deprecation-tables";
import { readStripe } from "./adapters/stripe";
import { readTokenFactory } from "./adapters/tokenfactory";
import { type PageReader, type ReaderReceipt, readVendorPage } from "./adapters/vendor-page";
import type { ChangeRecord, ProviderRecord } from "./schema";
import { type FetchedSource, type FetchResult, fetchSource, type PreviousFetch } from "./source";
import { gateV2, toChangeV2 } from "./v2";

/** What happened to one fetched URL: stored per source so the next run can send conditional GETs. */
export interface SourceOutcome {
  url: string;
  status: FetchResult["status"];
  checkedAt: string;
  contentHash?: string;
  etag?: string | null;
  lastModified?: string | null;
  error?: string;
}

export interface ProviderIngest {
  provider: string;
  /** True when no source changed, so the stored records stand. */
  unchanged: boolean;
  /** Contract v2 records, each through the quarantine gate. */
  records: ChangeV2[];
  outcomes: SourceOutcome[];
  /** Rows that could not become a valid v2 record (a reader bug, never silently dropped). */
  rejected: { id: string; error: string }[];
  /** Nemotron readings of discovered pages, and Tavily extract calls (empty for the precision readers). */
  receipts: ReaderReceipt[];
  tavily: TavilyUsage[];
  /** Items a model read that the quote check refused, with the reason. */
  dropped: { subject: string; reason: string }[];
}

export interface IngestOptions {
  /** Last fetch per URL (ETag, Last-Modified, hash). Omit to read everything fresh. */
  previous?: ReadonlyMap<string, PreviousFetch>;
  fetchImpl?: typeof fetch;
  /** "Today" for already-broken vs breaks-on-date. */
  now?: Date;
  /** Nemotron for discovered pages (`adapter: "discovered"`); without it those pages are not read. */
  reader?: PageReader;
}

/**
 * Reads every source of one provider, turns rows into records and passes each through the gate.
 * Linked pages (Stripe details, Token Factory notices) are fetched with limited concurrency.
 */
export async function ingestProvider(
  provider: ProviderRecord,
  options: IngestOptions = {},
): Promise<ProviderIngest> {
  const outcomes: SourceOutcome[] = [];
  const bodies = new Map<string, string>();
  const limit = limiter(CATALOG.linkedFetchConcurrency);

  const fetchTracked = async (url: string, conditional: boolean): Promise<FetchResult> => {
    const previous = conditional ? options.previous?.get(url) : undefined;
    const result = await fetchSource(url, previous, options.fetchImpl);
    outcomes.push(outcomeOf(url, result));
    if (result.status === "changed") bodies.set(url, result.source.body);
    return result;
  };
  // Linked pages are always read in full when their index changed: records need their quotes.
  const fetchLinked = (url: string) => limit(() => fetchTracked(url, false));

  let changed = false;
  const records: ChangeRecord[] = [];
  const receipts: ReaderReceipt[] = [];
  const tavily: TavilyUsage[] = [];
  const dropped: ProviderIngest["dropped"] = [];
  for (const source of provider.sources) {
    if (source.adapter === "discovered") {
      // A nominated page: Teire's own guarded copy, read by Nemotron, quotes checked against it.
      if (!options.reader) {
        outcomes.push({
          url: source.url,
          status: "failed",
          checkedAt: new Date().toISOString(),
          error: "no reader configured",
        });
        continue;
      }
      const page = await fetchDiscoveredPage(
        source.url,
        provider.officialDomains,
        options.previous?.get(source.url),
      );
      if (page.usage) tavily.push(page.usage);
      if (page.result.status !== "changed") {
        outcomes.push(outcomeOf(source.url, page.result));
        continue;
      }
      const fetched = page.result.source;
      try {
        const read = await readVendorPage(fetched, provider.slug, options.reader);
        records.push(...read.records);
        receipts.push(...read.receipts);
        dropped.push(...read.dropped.map((d) => ({ subject: d.item.subject, reason: d.reason })));
      } catch (error) {
        // Not read is not unchanged: the page's validators are not stored, so it is read again next time.
        outcomes.push({
          url: source.url,
          status: "failed",
          checkedAt: fetched.checkedAt,
          error: `reading failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
        });
        continue;
      }
      changed = true;
      outcomes.push(outcomeOf(source.url, page.result));
      // Quotes are stored as plain text (markdown markers removed); the gate checks them against the same.
      bodies.set(fetched.url, plainText(fetched.body));
      continue;
    }
    const result = await fetchTracked(source.url, true);
    if (result.status !== "changed") continue;
    changed = true;
    records.push(...(await readSource(source.adapter, result.source, fetchLinked)));
  }

  const converted: ChangeV2[] = [];
  const rejected: ProviderIngest["rejected"] = [];
  for (const row of records) {
    try {
      converted.push(gateV2(toChangeV2(row, provider, options.now), provider, bodies));
    } catch (error) {
      rejected.push({ id: row.id, error: String(error).slice(0, 500) });
    }
  }
  return {
    provider: provider.slug,
    unchanged: !changed,
    records: converted,
    outcomes,
    rejected,
    receipts,
    tavily,
    dropped,
  };
}

async function readSource(
  adapter: string,
  source: FetchedSource,
  fetchLinked: (url: string) => Promise<FetchResult>,
): Promise<ChangeRecord[]> {
  switch (adapter) {
    case "openai-deprecations":
      return readDeprecationTables(source, { provider: "openai", sectionLevel: 3 });
    case "anthropic-deprecations":
      return readAnthropic(source);
    case "gemini-deprecations":
      return readDeprecationTables(source, { provider: "google-gemini", sectionLevel: 2 });
    case "tokenfactory-notices":
      return readTokenFactory(source, fetchLinked);
    case "stripe-changelog":
      return readStripe(source, { fetchDetail: fetchLinked, since: CATALOG.stripeSince });
    default:
      throw new Error(`No adapter named ${adapter}`);
  }
}

function outcomeOf(url: string, result: FetchResult): SourceOutcome {
  if (result.status === "changed") {
    const { source } = result;
    return {
      url,
      status: "changed",
      checkedAt: source.checkedAt,
      contentHash: source.contentHash,
      etag: source.etag,
      lastModified: source.lastModified,
    };
  }
  if (result.status === "failed")
    return { url, status: "failed", checkedAt: result.checkedAt, error: result.error };
  return { url, status: "unchanged", checkedAt: result.checkedAt };
}

/** Runs at most `n` tasks at once; preserves call order of results. */
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            queue.shift()?.();
          });
      };
      if (active < n) run();
      else queue.push(run);
    });
}
