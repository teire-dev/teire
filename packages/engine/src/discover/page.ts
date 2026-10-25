import type { FetchResult, PreviousFetch } from "../catalog/source";
import { sha256 } from "../catalog/source";
import { DISCOVERY } from "../constants";
import { guardedFetch } from "../net/fetch";
import { type TavilyUsage, tavilyExtract } from "./tavily";

/**
 * Fetching a discovered notice page (the URL a search or an llms.txt nominated). Teire reads its own
 * copy through the guarded fetch, restricted to the provider's allowlisted domains at every redirect:
 *   1. the page's markdown twin (`…/deprecations.md`, served by Mintlify, Fern and similar docs sites);
 *   2. the page itself, HTML reduced to text (table cells kept as `| a | b |` rows);
 *   3. only when the page's own HTML holds no text (rendered by script), Tavily extract.
 * Quotes are later checked against exactly this body.
 */
export interface PageRead {
  result: FetchResult;
  /** The URL whose body was read (the markdown twin when it exists). */
  readUrl: string;
  via: "markdown" | "html" | "tavily-extract";
  usage?: TavilyUsage;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  hellip: "…",
};

/** HTML as plain text: scripts and styles dropped, block ends as newlines, table rows as `| a | b |`. */
export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<tr\b[^>]*>/gi, "\n| ")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|table|section|article|ul|ol|pre|blockquote|dd|dt)>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n${"#".repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X"))
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function hasExtension(url: string) {
  try {
    return /\.[a-z0-9]{1,5}$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export async function fetchDiscoveredPage(
  url: string,
  domains: readonly string[],
  previous: PreviousFetch = {},
): Promise<PageRead> {
  const checkedAt = new Date().toISOString();
  const allowHosts = domains.flatMap((d) => [d, `.${d}`]);
  const twin = hasExtension(url) ? null : `${url.replace(/\/+$/, "")}.md`;
  let lastError = "no readable body";
  for (const candidate of twin ? [twin, url] : [url]) {
    let res: Awaited<ReturnType<typeof guardedFetch>>;
    try {
      res = await guardedFetch(candidate, {
        allowHosts,
        etag: previous.etag ?? null,
        lastModified: previous.lastModified ?? null,
        headers: { accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" },
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (res.status === 304)
      return { result: { status: "unchanged", checkedAt }, readUrl: candidate, via: "markdown" };
    if (res.status !== 200) {
      lastError = `HTTP ${res.status} for ${candidate}`;
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    const markdown = /text\/(?:markdown|plain)/.test(type);
    // A site that answers the twin with its HTML app shell has no markdown twin.
    if (candidate === twin && !markdown) continue;
    let body = markdown ? res.text() : htmlToText(res.text());
    let via: PageRead["via"] = markdown ? "markdown" : "html";
    let usage: TavilyUsage | undefined;
    if (body.length < DISCOVERY.minPageChars && !markdown) {
      try {
        const extracted = await tavilyExtract(url);
        usage = extracted.usage;
        if (extracted.content && extracted.content.length > body.length) {
          body = extracted.content;
          via = "tavily-extract";
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    const contentHash = sha256(body);
    if (previous.contentHash === contentHash)
      return {
        result: { status: "unchanged", checkedAt },
        readUrl: candidate,
        via,
        ...(usage ? { usage } : {}),
      };
    return {
      result: {
        status: "changed",
        source: {
          url: res.finalUrl,
          body,
          contentHash,
          checkedAt,
          etag: res.headers.get("etag"),
          lastModified: res.headers.get("last-modified"),
        },
      },
      readUrl: res.finalUrl,
      via,
      ...(usage ? { usage } : {}),
    };
  }
  return { result: { status: "failed", checkedAt, error: lastError }, readUrl: url, via: "html" };
}
