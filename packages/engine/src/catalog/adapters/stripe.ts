import { codeSpans, column, isoDate, plain, sections, tables } from "../markdown";
import { CATALOG_SCHEMA_VERSION, type ChangeRecord, changeId } from "../schema";
import type { FetchedSource, FetchResult } from "../source";

/**
 * Stripe publishes `changelog.md` with one row per change and a "Breaking change?" column, and a
 * `.md` page per change whose "Changes" section lists every field per SDK language. Both are read by
 * code: rows marked Breaking become records, the detail tables become search signatures.
 */
export interface StripeOptions {
  /** Fetches a detail page; injected so ingestion can apply conditional GETs and concurrency. */
  fetchDetail: (url: string) => Promise<FetchResult>;
  /** Preview API versions are opt-in; skipped unless asked. */
  includePreview?: boolean;
  /** Only versions released on or after this date (YYYY-MM-DD). */
  since?: string;
}

interface BreakingRow {
  version: string;
  title: string;
  url: string;
  products: string;
  raw: string;
}

/** Languages Teire scans, as Stripe names them in the "Changes" section. */
const SDK_SECTIONS = { "Node.js": "npm", Python: "pypi" } as const;

export function breakingRows(
  changelog: FetchedSource,
  options: Pick<StripeOptions, "includePreview" | "since">,
) {
  const rows: BreakingRow[] = [];
  for (const section of sections(changelog.body, 2)) {
    const version = section.heading.trim();
    // Versions before 2024-09-30 have no codename suffix ("2024-06-20").
    if (!/^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/.test(version)) continue;
    if (!options.includePreview && version.endsWith(".preview")) continue;
    if (options.since && version.slice(0, 10) < options.since) continue;
    for (const table of tables(section.body)) {
      const breakingCol = column(table.header, /breaking/i);
      const productsCol = column(table.header, /product/i);
      if (breakingCol < 0) continue;
      for (const row of table.rows) {
        if (plain(row.cells[breakingCol] ?? "").toLowerCase() !== "breaking") continue;
        const link = /\[([^\]]+)\]\((https:\/\/docs\.stripe\.com\/changelog\/[^)]+\.md)\)/.exec(
          row.cells[0] ?? "",
        );
        if (!link) continue;
        rows.push({
          version,
          title: link[1] ?? "",
          url: link[2] ?? "",
          products: plain(row.cells[productsCol] ?? ""),
          raw: row.raw,
        });
      }
    }
  }
  return rows;
}

export async function readStripe(changelog: FetchedSource, options: StripeOptions): Promise<ChangeRecord[]> {
  // fetchDetail bounds concurrency; results keep changelog order.
  return Promise.all(
    breakingRows(changelog, options).map(async (row) => {
      const detail = await options.fetchDetail(row.url);
      return recordFor(row, changelog, detail.status === "changed" ? detail.source : null);
    }),
  );
}

function firstParagraph(text: string) {
  return (
    text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith("|") && !p.startsWith("#")) ?? ""
  );
}

function recordFor(row: BreakingRow, changelog: FetchedSource, detail: FetchedSource | null): ChangeRecord {
  const announcedOn = isoDate(row.version);
  const slug = row.url.split("/").pop()?.replace(/\.md$/, "") ?? row.title;
  const base = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    id: changeId("stripe", announcedOn, `${row.version.split(".")[1] ?? "v"}-${slug}`),
    provider: "stripe",
    title: row.title,
    announcedOn,
    effectiveOn: null,
    breaking: true,
    replacement: null,
    extraction: { method: "table" },
  } satisfies Partial<ChangeRecord>;
  const changelogSource = {
    url: changelog.url,
    quote: row.raw,
    contentHash: changelog.contentHash,
    checkedAt: changelog.checkedAt,
  };

  if (!detail) {
    return {
      ...base,
      kind: "behaviour-change",
      summary: `Breaking change in API version ${row.version} (${row.products}).`,
      signatures: {
        modelIds: [],
        params: [],
        endpoints: [],
        symbols: [],
        packages: [],
        apiVersions: [row.version],
      },
      migrationNotes: [],
      sources: [changelogSource],
      status: "quarantined",
      quarantineReasons: ["The change's detail page could not be read, so its fields are unknown."],
    };
  }

  const parts = new Map(
    sections(detail.body, 2).map((s) => [s.heading.replace(/’/g, "'").toLowerCase(), s.body]),
  );
  const whatsNew = firstParagraph(parts.get("what's new") ?? "");
  const why = firstParagraph(parts.get("why is this a breaking change?") ?? "");
  const impact = (parts.get("impact") ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("|"))
    .map((line) => line.replace(/^[-*]\s+/, ""));

  const params = new Set<string>();
  const symbols = new Set<string>();
  const packages: { ecosystem: "npm" | "pypi"; name: string }[] = [];
  for (const lang of sections(parts.get("changes") ?? "", 4)) {
    const isRest = lang.heading === "REST API";
    const ecosystem = SDK_SECTIONS[lang.heading as keyof typeof SDK_SECTIONS];
    if (!isRest && !ecosystem) continue;
    let touched = false;
    for (const table of tables(lang.body)) {
      const changeCol = column(table.header, /^change$/i);
      for (const r of table.rows) {
        const change = plain(r.cells[changeCol] ?? "").toLowerCase();
        if (change === "added") continue;
        for (const name of codeSpans(r.cells[0] ?? "")) {
          touched = true;
          if (isRest) params.add(name.split(/[.#]/).pop() ?? name);
          else symbols.add(name);
        }
      }
    }
    if (ecosystem && touched) packages.push({ ecosystem, name: "stripe" });
  }

  const quote = why || whatsNew || (detail.body.split("\n")[0] ?? "");
  return {
    ...base,
    kind: params.size > 0 ? "parameter-change" : "behaviour-change",
    summary: [whatsNew, why].filter(Boolean).map(plain).join(" "),
    signatures: {
      modelIds: [],
      params: [...params],
      endpoints: [],
      symbols: [...symbols],
      packages,
      apiVersions: [row.version],
    },
    migrationNotes: impact.map(plain),
    sources: [
      changelogSource,
      { url: detail.url, quote, contentHash: detail.contentHash, checkedAt: detail.checkedAt },
    ],
    // Confirmed from Stripe's own pages. With no fields listed, scans report it as "check by hand".
    status: "confirmed",
    quarantineReasons: [],
  };
}
