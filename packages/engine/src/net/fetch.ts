import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NET } from "../constants";

/**
 * The one fetch routine for every URL Teire did not write itself (plan D75): registries, package
 * repositories, vendor pages, repo-declared URLs. Each hop of a redirect is checked again:
 * HTTPS only, host allowlist when given, no private or local addresses, size and time caps.
 */
export interface GuardedFetchOptions {
  /** When set, every hop's host must match one of these (exact host or `.suffix`). */
  allowHosts?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Conditional request validators. */
  etag?: string | null;
  lastModified?: string | null;
}

export interface GuardedResponse {
  status: number;
  url: string;
  finalUrl: string;
  redirects: string[];
  headers: Headers;
  body: Uint8Array;
  text(): string;
  json<T>(): T;
}

export class BlockedUrlError extends Error {}

function hostAllowed(host: string, allow?: readonly string[]) {
  if (!allow) return true;
  return allow.some((entry) =>
    entry.startsWith(".") ? host.endsWith(entry) || host === entry.slice(1) : host === entry,
  );
}

/** RFC 1918, loopback, link-local, CGNAT, unique-local and unspecified ranges. */
export function isPrivateAddress(address: string) {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

async function checkUrl(raw: string, allow?: readonly string[]) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new BlockedUrlError(`not https: ${url.origin}`);
  if (url.username || url.password) throw new BlockedUrlError("credentials in URL");
  if (!hostAllowed(url.hostname, allow)) throw new BlockedUrlError(`host not allowed: ${url.hostname}`);
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true });
  if (addresses.some((a) => isPrivateAddress(a.address)))
    throw new BlockedUrlError(`private address for ${url.hostname}`);
  return url;
}

export async function guardedFetch(
  input: string,
  options: GuardedFetchOptions = {},
): Promise<GuardedResponse> {
  const maxBytes = options.maxBytes ?? NET.maxResponseBytes;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? NET.timeoutMs);
  const headers: Record<string, string> = { "user-agent": NET.userAgent, ...options.headers };
  if (options.etag) headers["if-none-match"] = options.etag;
  if (options.lastModified) headers["if-modified-since"] = options.lastModified;

  const redirects: string[] = [];
  let current = input;
  for (let hop = 0; hop <= NET.maxRedirects; hop++) {
    await checkUrl(current, options.allowHosts);
    const response = await fetch(current, { headers, redirect: "manual", signal: deadline });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel();
      redirects.push(current);
      current = new URL(response.headers.get("location") as string, current).toString();
      // Conditional headers apply to the first URL only.
      delete headers["if-none-match"];
      delete headers["if-modified-since"];
      continue;
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      await response.body?.cancel();
      throw new BlockedUrlError(`response larger than ${maxBytes} bytes`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new BlockedUrlError(`response larger than ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      status: response.status,
      url: input,
      finalUrl: current,
      redirects,
      headers: response.headers,
      body,
      text: () => new TextDecoder().decode(body),
      json: <T>() => JSON.parse(new TextDecoder().decode(body)) as T,
    };
  }
  throw new BlockedUrlError(`more than ${NET.maxRedirects} redirects`);
}
