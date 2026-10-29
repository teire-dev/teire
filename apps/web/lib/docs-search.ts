import { createFromSource } from "fumadocs-core/search/server";
import { source } from "./source";

/** The docs' search index (Orama), built from every page: the search route and Ask Teire share it. */
export const docsSearch = createFromSource(source);

/**
 * Docs answers for Ask Teire (and its budget-reached fallback): the best matching sections, each with
 * its page link, plus the top page's own text so an answer can quote the docs instead of guessing.
 */
export async function searchDocs(query: string, limit = 5) {
  const hits = await docsSearch.search(query.slice(0, 200));
  const seen = new Set<string>();
  const results: { title: string; url: string; snippet: string }[] = [];
  for (const hit of hits) {
    const page = hit.url.split("#")[0] ?? hit.url;
    if (seen.has(page)) continue;
    seen.add(page);
    const title =
      source.getPage(
        page
          .replace(/^\/docs\/?/, "")
          .split("/")
          .filter(Boolean),
      )?.data.title ?? page;
    results.push({
      title,
      url: hit.url,
      snippet: String(hit.content)
        .replace(/<[^>]+>/g, "")
        .slice(0, 240),
    });
    if (results.length >= limit) break;
  }
  const top = results[0]
    ? source.getPage(
        (results[0].url.split("#")[0] ?? "")
          .replace(/^\/docs\/?/, "")
          .split("/")
          .filter(Boolean),
      )
    : undefined;
  const text = top ? (await top.data.getText("processed")).slice(0, 2_500) : null;
  return { results, top: top && text ? { title: top.data.title, url: top.url, text } : null };
}
