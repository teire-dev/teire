import { codeSpans, column, isoDate, plain, type Row, sections, tables } from "../markdown";
import {
  CATALOG_SCHEMA_VERSION,
  type ChangeKind,
  type ChangeRecord,
  changeId,
  type Signatures,
} from "../schema";
import type { FetchedSource } from "../source";

/**
 * Reads provider deprecation pages that publish one table row per retired model, endpoint or header:
 * OpenAI and Anthropic (dated `###` sections), Gemini (`##` family sections, no announcement date)
 * and Token Factory notices (one table, date in the prose). Rows become records; nothing is inferred.
 */
export interface DeprecationTableOptions {
  provider: string;
  /** Heading level that starts each announcement or model family. */
  sectionLevel: number;
  /** Date that applies to every row when the table has no date column (Token Factory notices). */
  documentDate?: string | null;
  /** The provider's sentence that states `documentDate`, added to every record as a second source quote. */
  documentDateQuote?: string;
  /** Section headings to skip entirely. */
  skipSection?: RegExp;
  /** Column headers a provider's own table uses, when they differ from the usual ones (C13). */
  columns?: { subject?: RegExp; date?: RegExp; replacement?: RegExp };
}

const DATE_COLUMN = [/shutdown/i, /retirement/i, /removal/i];
const REPLACEMENT_COLUMN = [/replacement/i, /substitute/i];
const SUBJECT_COLUMN = [/^(?!.*(price|replacement|substitute)).*(model|snapshot|system)/i];

/** Phrases providers use when the old ID keeps working but now serves another model. */
const REROUTED = /automatically routes|now points to|redirect(s|ed)? to/i;

export function readDeprecationTables(
  source: FetchedSource,
  options: DeprecationTableOptions,
): ChangeRecord[] {
  const records: ChangeRecord[] = [];
  const parts =
    options.sectionLevel > 0
      ? sections(source.body, options.sectionLevel)
      : [{ level: 0, heading: "", body: source.body }];

  for (const section of parts) {
    if (options.skipSection?.test(section.heading)) continue;
    const announcedOn = /^\d{4}-\d{2}-\d{2}/.test(section.heading) ? isoDate(section.heading) : null;
    const sectionTitle = section.heading.replace(/^\d{4}-\d{2}-\d{2}:\s*/, "").replace(/`/g, "");

    for (const table of tables(section.body)) {
      const subjectCol = column(
        table.header,
        ...(options.columns?.subject ? [options.columns.subject] : SUBJECT_COLUMN),
      );
      const replacementCol = column(
        table.header,
        ...(options.columns?.replacement ? [options.columns.replacement] : REPLACEMENT_COLUMN),
      );
      // A table qualifies when it names what is going away and either when or what replaces it.
      if (subjectCol < 0) continue;
      const dateCol = column(table.header, ...(options.columns?.date ? [options.columns.date] : DATE_COLUMN));
      if (replacementCol < 0 && dateCol < 0 && !options.documentDate) continue;

      for (const row of table.rows) {
        const record = recordFromRow(row, {
          source,
          provider: options.provider,
          announcedOn,
          sectionTitle,
          subjectCell: row.cells[subjectCol] ?? "",
          replacementCell: replacementCol >= 0 ? (row.cells[replacementCol] ?? "") : "",
          dateCell: dateCol >= 0 ? (row.cells[dateCol] ?? "") : null,
          documentDate: options.documentDate ?? null,
          documentDateQuote: options.documentDateQuote,
        });
        if (record) records.push(record);
      }
    }
  }
  return dedupe(records);
}

interface RowContext {
  source: FetchedSource;
  provider: string;
  announcedOn: string | null;
  sectionTitle: string;
  subjectCell: string;
  replacementCell: string;
  dateCell: string | null;
  documentDate: string | null;
  documentDateQuote?: string;
}

function recordFromRow(row: Row, ctx: RowContext): ChangeRecord | null {
  const subjectText = plain(ctx.subjectCell);
  const ids = codeSpans(ctx.subjectCell);
  // Sub-header rows such as "| Preview models ||||" carry a label but no identifier and empty cells.
  if (!subjectText) return null;
  if (ids.length === 0 && row.cells.length > 1 && row.cells.slice(1).every((cell) => !cell)) return null;

  const replacementText = plain(ctx.replacementCell);
  const effectiveOn = ctx.dateCell === null ? ctx.documentDate : isoDate(ctx.dateCell);
  const noDate = ctx.dateCell !== null && /^(n\/?a|)$/i.test(plain(ctx.dateCell));
  const rerouted = REROUTED.test(replacementText);

  // A model listed with no shutdown date and no replacement is not a change (Gemini lists every model).
  if (!effectiveOn && !replacementText) return null;

  const endpoints = ids.filter((id) => id.startsWith("/"));
  const modelIds = ids.filter((id) => !id.startsWith("/"));
  const kind: ChangeKind = rerouted
    ? "model-rerouted"
    : endpoints.length > 0
      ? "endpoint-removal"
      : modelIds.length > 0
        ? "model-retirement"
        : "endpoint-removal";

  const signatures: Signatures = {
    modelIds,
    endpoints,
    params: [],
    symbols: [],
    packages: [],
    apiVersions: [],
  };
  const replacementIds = codeSpans(ctx.replacementCell);
  const replacementNote = /\(([^)]+)\)/.exec(replacementText)?.[1];
  const subject = ids[0] ?? subjectText;

  // Titles stay true whatever today's date is; the UI adds "in 37 days" / "retired 12 days ago".
  const title = rerouted
    ? `${subject} rerouted to ${replacementIds[0] ?? replacementText}`
    : effectiveOn
      ? `${subject} shutdown`
      : `${subject} deprecated`;

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    id: changeId(ctx.provider, effectiveOn ?? ctx.announcedOn, subject),
    provider: ctx.provider,
    kind,
    title,
    summary: [
      ctx.sectionTitle && `${ctx.sectionTitle}.`,
      effectiveOn
        ? `Shutdown date: ${effectiveOn}.`
        : noDate
          ? "No shutdown date."
          : "No shutdown date announced.",
      replacementText ? `Replacement: ${replacementText}.` : "No replacement named.",
    ]
      .filter(Boolean)
      .join(" "),
    announcedOn: ctx.announcedOn,
    effectiveOn: rerouted ? null : effectiveOn,
    breaking: !rerouted,
    signatures,
    replacement: replacementText
      ? {
          value: replacementText,
          ...(replacementNote ? { note: replacementNote } : {}),
          modelIds: replacementIds.filter((id) => !id.startsWith("/")),
        }
      : null,
    migrationNotes: [],
    sources: [
      row.raw,
      ...(ctx.dateCell === null && ctx.documentDateQuote ? [ctx.documentDateQuote] : []),
    ].map((quote) => ({
      url: ctx.source.url,
      quote,
      contentHash: ctx.source.contentHash,
      checkedAt: ctx.source.checkedAt,
    })),
    extraction: { method: "table" },
    // Read by code from the provider's own table. A row without identifiers ("Assistants API") stays
    // confirmed; scans report it as "check by hand" because there is nothing exact to search for.
    status: "confirmed",
    quarantineReasons: [],
  };
}

/** A model listed in two sections (re-announced) keeps one record per id, with every quote as a source. */
function dedupe(records: ChangeRecord[]) {
  const byId = new Map<string, ChangeRecord>();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      continue;
    }
    for (const source of record.sources) {
      if (!existing.sources.some((s) => s.quote === source.quote)) existing.sources.push(source);
    }
  }
  return [...byId.values()];
}
