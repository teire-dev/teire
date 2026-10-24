import { codeSpans, column, isoDate, plain, sections, tables } from "../markdown";
import { CATALOG_SCHEMA_VERSION, type ChangeRecord, changeId } from "../schema";
import type { FetchedSource } from "../source";
import { readDeprecationTables } from "./deprecation-tables";

/**
 * Anthropic's model-deprecations page: dated `###` model sections (shared table reader) plus an
 * "API parameter deprecations" table whose rows name parameters removed in a given API version.
 */
export function readAnthropic(source: FetchedSource): ChangeRecord[] {
  return [
    ...readDeprecationTables(source, { provider: "anthropic", sectionLevel: 3 }),
    ...readParameters(source),
  ];
}

function readParameters(source: FetchedSource): ChangeRecord[] {
  const section = sections(source.body, 2).find((s) => /parameter deprecations/i.test(s.heading));
  if (!section) return [];
  const records: ChangeRecord[] = [];
  for (const table of tables(section.body)) {
    const paramCol = column(table.header, /^parameter/i);
    const statusCol = column(table.header, /^status/i);
    const behaviourCol = column(table.header, /^behavio/i);
    const replacementCol = column(table.header, /replacement/i);
    if (paramCol < 0 || statusCol < 0) continue;
    for (const row of table.rows) {
      const params = codeSpans(row.cells[paramCol] ?? "");
      if (params.length === 0) continue;
      const status = plain(row.cells[statusCol] ?? "");
      const apiVersions = codeSpans(row.cells[statusCol] ?? "").filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
      const effectiveOn = isoDate(status);
      const replacement = replacementCol >= 0 ? plain(row.cells[replacementCol] ?? "") : "";
      const behaviour = behaviourCol >= 0 ? plain(row.cells[behaviourCol] ?? "") : "";
      records.push({
        schemaVersion: CATALOG_SCHEMA_VERSION,
        id: changeId("anthropic", effectiveOn, `params-${params.join("-")}`),
        provider: "anthropic",
        kind: "parameter-change",
        title: `${params.join(", ")}: ${status.charAt(0).toLowerCase()}${status.slice(1)}`,
        summary: [status, behaviour].filter(Boolean).join(". "),
        announcedOn: null,
        effectiveOn,
        breaking: true,
        signatures: { modelIds: [], params, endpoints: [], symbols: [], packages: [], apiVersions },
        replacement: replacement ? { value: replacement, modelIds: [] } : null,
        migrationNotes: behaviour ? [behaviour] : [],
        sources: [
          { url: source.url, quote: row.raw, contentHash: source.contentHash, checkedAt: source.checkedAt },
        ],
        extraction: { method: "table" },
        status: "confirmed",
        quarantineReasons: [],
      });
    }
  }
  return records;
}
