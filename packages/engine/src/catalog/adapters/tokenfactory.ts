import { isoDate } from "../markdown";
import type { ChangeRecord } from "../schema";
import type { FetchedSource, FetchResult } from "../source";
import { readDeprecationTables } from "./deprecation-tables";

/**
 * Token Factory announces removals as one docs page per batch ("Model Deprecations: August 2026"),
 * listed in its llms.txt. Each page has one table and states the date once in bold.
 * The public model catalog (models_info) carries no retirement fields, so it is not a source here.
 */
export function noticeUrls(llmsTxt: string) {
  const urls = [
    ...llmsTxt.matchAll(/\((https:\/\/docs\.tokenfactory\.nebius\.com\/[^)]*deprecation[^)]*\.md)\)/gi),
  ];
  return [...new Set(urls.map((m) => m[1] ?? ""))].filter(Boolean);
}

/** The first bold phrase holding a date, and the line it sits on (kept as the date's quote). */
export function noticeDate(body: string) {
  for (const line of body.split("\n")) {
    for (const bold of line.matchAll(/\*\*([^*]+)\*\*/g)) {
      const date = isoDate(bold[1] ?? "");
      if (date) return { date, quote: line.trim() };
    }
  }
  return null;
}

export async function readTokenFactory(
  index: FetchedSource,
  fetchNotice: (url: string) => Promise<FetchResult>,
): Promise<ChangeRecord[]> {
  const notices = await Promise.all(noticeUrls(index.body).map(fetchNotice));
  return notices.flatMap((result): ChangeRecord[] => {
    if (result.status !== "changed") return [];
    const stated = noticeDate(result.source.body);
    return readDeprecationTables(result.source, {
      provider: "nebius-token-factory",
      sectionLevel: 0,
      documentDate: stated?.date ?? null,
      documentDateQuote: stated?.quote,
    });
  });
}
