import { createHash } from "node:crypto";
import { CATALOG } from "../constants";

/** One fetched provider page, as every adapter receives it. */
export interface FetchedSource {
  url: string;
  body: string;
  /** sha256 of `body`; records quote text from exactly this body. */
  contentHash: string;
  checkedAt: string;
  etag: string | null;
  lastModified: string | null;
}

export interface PreviousFetch {
  etag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
}

export type FetchResult =
  | { status: "changed"; source: FetchedSource }
  | { status: "unchanged"; checkedAt: string }
  | { status: "failed"; checkedAt: string; error: string };

export function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Conditional GET (ETag / If-Modified-Since) plus a content hash, so unchanged pages cost one
 * request and no parsing (plan: catalog ingestion).
 */
export async function fetchSource(
  url: string,
  previous: PreviousFetch = {},
  fetchImpl = fetch,
  extraHeaders: Record<string, string> = {},
): Promise<FetchResult> {
  const checkedAt = new Date().toISOString();
  const headers: Record<string, string> = {
    "user-agent": CATALOG.userAgent,
    accept: "text/markdown, text/plain, */*",
    ...extraHeaders,
  };
  if (previous.etag) headers["if-none-match"] = previous.etag;
  if (previous.lastModified) headers["if-modified-since"] = previous.lastModified;
  try {
    const res = await fetchImpl(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(CATALOG.fetchTimeoutMs),
    });
    if (res.status === 304) return { status: "unchanged", checkedAt };
    if (!res.ok) return { status: "failed", checkedAt, error: `HTTP ${res.status}` };
    const body = await res.text();
    const contentHash = sha256(body);
    if (previous.contentHash === contentHash) return { status: "unchanged", checkedAt };
    return {
      status: "changed",
      source: {
        url,
        body,
        contentHash,
        checkedAt,
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
      },
    };
  } catch (error) {
    return { status: "failed", checkedAt, error: error instanceof Error ? error.message : String(error) };
  }
}
