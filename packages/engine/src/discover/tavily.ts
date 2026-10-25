import { DISCOVERY } from "../constants";

/**
 * Tavily's REST API (context/05-tavily/api-reference.md), called with `fetch` instead of the SDK, which
 * pulls `axios` with a caret range (research cross-cutting.md §8). Search only nominates pages: every
 * URL it returns is checked against the provider's allowlist and fetched again by Teire before
 * anything is read from it. Extract is the fallback for pages whose own HTML holds no text.
 */
export interface TavilyUsage {
  endpoint: "search" | "extract";
  credits: number;
  requestId: string | null;
  ms: number;
}

export interface TavilySearchResult {
  url: string;
  title: string;
  score: number;
}

function headers() {
  const key = process.env.TAVILY_API_KEY;
  return {
    "content-type": "application/json",
    // Keyless mode serves /search and /extract, rate-limited, when no key is configured.
    ...(key ? { authorization: `Bearer ${key}` } : { "x-tavily-access-mode": "keyless" }),
    "x-client-source": "teire",
  };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${DISCOVERY.tavily.url}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DISCOVERY.tavily.timeoutMs),
  });
  if (!res.ok) throw new Error(`Tavily ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export async function tavilySearch(
  query: string,
  includeDomains: string[],
): Promise<{ results: TavilySearchResult[]; usage: TavilyUsage }> {
  const started = Date.now();
  const data = await post<{
    results?: { url: string; title?: string; score?: number }[];
    usage?: { credits?: number };
    request_id?: string;
  }>("/search", {
    query,
    search_depth: DISCOVERY.tavily.searchDepth,
    max_results: DISCOVERY.tavily.maxResults,
    include_domains: includeDomains,
    include_usage: true,
  });
  return {
    results: (data.results ?? []).map((r) => ({ url: r.url, title: r.title ?? "", score: r.score ?? 0 })),
    usage: {
      endpoint: "search",
      credits: data.usage?.credits ?? 1,
      requestId: data.request_id ?? null,
      ms: Date.now() - started,
    },
  };
}

export async function tavilyExtract(url: string): Promise<{ content: string | null; usage: TavilyUsage }> {
  const started = Date.now();
  const data = await post<{
    results?: { url: string; raw_content?: string }[];
    usage?: { credits?: number };
    request_id?: string;
  }>("/extract", {
    urls: [url],
    extract_depth: "advanced",
    format: "markdown",
    include_usage: true,
  });
  return {
    content: data.results?.[0]?.raw_content ?? null,
    usage: {
      endpoint: "extract",
      credits: data.usage?.credits ?? 0,
      requestId: data.request_id ?? null,
      ms: Date.now() - started,
    },
  };
}
