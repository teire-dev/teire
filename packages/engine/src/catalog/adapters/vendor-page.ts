import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { DISCOVERY } from "../../constants";
import { type ModelPrice, nemotronOptions, nemotronSampling, receiptFor, type TokenFactory } from "../../llm";
import { quoteInSource } from "../../notes/extract";
import { CATALOG_SCHEMA_VERSION, type ChangeKind, type ChangeRecord, changeId } from "../schema";
import type { FetchedSource } from "../source";
import { sha256 } from "../source";

/**
 * A provider's own notice page with no hand-written reader (plan S04, D82): Nemotron 3 Ultra reads it
 * into one item per retired model, endpoint, parameter or API version, each with a verbatim quote.
 * Code then decides what stands (plan D40):
 *  - the quote must be in the page Teire fetched itself;
 *  - the identifier and every replacement must be inside that quote (others are dropped);
 *  - the gate (v2.ts) also requires the shutdown date to be written in the quote.
 * The model only points; the page's own words are the record.
 */
export interface PageReader {
  tf: TokenFactory;
  prices?: Map<string, ModelPrice>;
  /** One reading per (model, prompt): the worker backs this with `extraction_cache`. */
  cached?: <T>(
    model: string,
    promptHash: string,
    compute: () => Promise<{ value: T; costUsd: number }>,
  ) => Promise<{ value: T; cached: boolean }>;
}

export interface ReaderReceipt {
  step: "read-page";
  model: string;
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  costUsd: number;
  ms: number;
  cached: boolean;
}

const itemSchema = z.object({
  kind: z.enum(["model-retirement", "endpoint-removal", "parameter-change", "api-version-sunset"]),
  subject: z
    .string()
    .describe(
      "Exactly one model ID, endpoint path, parameter name or API version, copied exactly as written",
    ),
  shutdownDate: z
    .string()
    .nullable()
    .describe("The date requests stop working, as YYYY-MM-DD, or null when the page gives none"),
  announcedDate: z.string().nullable().describe("When the provider announced it, as YYYY-MM-DD, or null"),
  replacements: z
    .array(z.string())
    .max(4)
    .describe("Identifiers the page recommends instead, exactly as written; [] when it names none"),
  quote: z
    .string()
    .describe(
      "One contiguous passage copied verbatim from the page, at most 400 characters (a table row or a sentence), containing the subject, the shutdown date as written and the replacements",
    ),
});
const pageSchema = z.object({ items: z.array(itemSchema) });
type PageItem = z.infer<typeof itemSchema>;

const SYSTEM = `You read an API provider's own page about deprecations, retirements, shutdowns or breaking changes, for developers whose code calls this provider. List every model, endpoint, request parameter or API version the page says is deprecated, retired, shut down, decommissioned or removed.
Rules:
- One item per identifier: a table row naming two models becomes two items.
- Copy identifiers exactly as the page writes them (case, slashes, dots, dates inside names). Never shorten or normalise them.
- shutdownDate: the day requests stop working, converted to YYYY-MM-DD (US pages write MM/DD/YY). null when the page gives no such date.
- replacements: only identifiers the page itself recommends for that subject, exactly as written.
- quote: copy one contiguous passage verbatim, character for character, that contains the subject, the date as written and the replacements (for a table, the whole row).
- Skip policy text, pricing, new launches and anything that still works unchanged.
- Never invent identifiers, dates or replacements. Return an empty list when the page lists nothing.`;

/** Heading-aligned chunks of at most `DISCOVERY.chunkChars`, so long pages are read whole. */
export function chunksOf(text: string) {
  const sections = text.split(/\n(?=#{1,4} )/);
  const chunks: string[] = [];
  let current = "";
  for (const section of sections) {
    if (current && current.length + section.length > DISCOVERY.chunkChars) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + section;
    while (current.length > DISCOVERY.chunkChars) {
      chunks.push(current.slice(0, DISCOVERY.chunkChars));
      current = current.slice(DISCOVERY.chunkChars);
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.slice(0, DISCOVERY.maxChunks);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d: string | null) =>
  d && ISO.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) ? d : null;
const clean = (id: string) => id.trim().replace(/^[`'"]+|[`'".,;:]+$/g, "");

function recordOf(item: PageItem, quote: string, source: FetchedSource, provider: string, model: string) {
  const subject = clean(item.subject);
  const replacements = item.replacements.map(clean).filter((r) => r && r !== subject && quote.includes(r));
  const effectiveOn = validDate(item.shutdownDate);
  const announcedOn = validDate(item.announcedDate);
  const kind: ChangeKind = item.kind;
  const record: ChangeRecord = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    id: changeId(provider, effectiveOn ?? announcedOn, subject),
    provider,
    kind,
    title: effectiveOn ? `${subject} shutdown` : `${subject} deprecated`,
    summary: [
      effectiveOn ? `Shutdown date: ${effectiveOn}.` : "No shutdown date announced.",
      replacements.length ? `Replacement: ${replacements.join(" or ")}.` : "No replacement named.",
    ].join(" "),
    announcedOn,
    effectiveOn,
    breaking: true,
    signatures: {
      modelIds: kind === "model-retirement" ? [subject] : [],
      endpoints: kind === "endpoint-removal" ? [subject] : [],
      params: kind === "parameter-change" ? [subject] : [],
      symbols: [],
      packages: [],
      apiVersions: kind === "api-version-sunset" ? [subject] : [],
    },
    replacement: replacements.length
      ? {
          value: replacements.join(" or "),
          modelIds: kind === "model-retirement" ? replacements : [],
        }
      : null,
    migrationNotes: [],
    sources: [{ url: source.url, quote, contentHash: source.contentHash, checkedAt: source.checkedAt }],
    extraction: { method: "model", model },
    status: "confirmed",
    quarantineReasons: [],
  };
  return record;
}

export async function readVendorPage(
  source: FetchedSource,
  provider: string,
  reader: PageReader,
): Promise<{
  records: ChangeRecord[];
  dropped: { item: PageItem; reason: string }[];
  receipts: ReaderReceipt[];
}> {
  const model = reader.tf.modelId("reader");
  const records: ChangeRecord[] = [];
  const dropped: { item: PageItem; reason: string }[] = [];
  const receipts: ReaderReceipt[] = [];
  for (const chunk of chunksOf(source.body)) {
    // Static instructions first, the page next: prefix caching works across chunks and providers.
    const prompt = `<page url="${source.url}">\n${chunk}\n</page>`;
    const promptHash = sha256(`${SYSTEM}\n${prompt}`);
    const started = Date.now();
    const compute = async () => {
      try {
        const result = await generateText({
          model: reader.tf.model("reader"),
          system: SYSTEM,
          prompt,
          output: Output.object({ schema: pageSchema }),
          maxOutputTokens: DISCOVERY.readerMaxOutputTokens,
          ...nemotronSampling,
          providerOptions: nemotronOptions({ thinking: false }),
        });
        const receipt = receiptFor(result.usage, reader.prices?.get(model));
        return { value: { items: result.output.items, receipt }, costUsd: receipt.costUsd };
      } catch (error) {
        // An answer that does not parse is paid for and yields nothing (never a guess).
        if (!NoObjectGeneratedError.isInstance(error)) throw error;
        const receipt = receiptFor(
          error.usage ?? ({} as Parameters<typeof receiptFor>[0]),
          reader.prices?.get(model),
        );
        return { value: { items: [] as PageItem[], receipt }, costUsd: receipt.costUsd };
      }
    };
    const { value, cached } = reader.cached
      ? await reader.cached(model, promptHash, compute)
      : { value: (await compute()).value, cached: false };
    receipts.push({ step: "read-page", model, ...value.receipt, ms: Date.now() - started, cached });
    for (const item of value.items) {
      const quote = quoteInSource(item.quote, source.body);
      if (!quote) {
        dropped.push({ item, reason: "quote not found in the fetched page" });
        continue;
      }
      if (!quote.includes(clean(item.subject))) {
        dropped.push({ item, reason: "the identifier is not in its quote" });
        continue;
      }
      records.push(recordOf(item, quote, source, provider, model));
    }
  }
  // A subject read twice (two chunks, or re-announced) keeps one record with every quote.
  const byId = new Map<string, ChangeRecord>();
  for (const r of records) {
    const known = byId.get(r.id);
    if (!known) byId.set(r.id, r);
    else
      for (const s of r.sources) if (!known.sources.some((k) => k.quote === s.quote)) known.sources.push(s);
  }
  return { records: [...byId.values()], dropped, receipts };
}
