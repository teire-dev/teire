import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { cancelSignal } from "../cancel";
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
  /** Return the body as a capped stream (`stream`) instead of reading it into `body`. */
  stream?: boolean;
}

export interface GuardedResponse {
  status: number;
  url: string;
  finalUrl: string;
  redirects: string[];
  headers: Headers;
  body: Uint8Array;
  /** Set when the request asked for `stream`: the body, capped at `maxBytes`, as it arrives. */
  stream?: AsyncIterable<Uint8Array>;
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

/**
 * Why a host can't receive a credential (S-P19): it doesn't resolve, or it resolves to a private,
 * loopback or link-local address. Null for a public host.
 */
export async function privateHostReason(host: string): Promise<string | null> {
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => null);
  if (!addresses?.length) return `${host} doesn't resolve`;
  const inside = addresses.find((a) => isPrivateAddress(a.address));
  return inside ? `${host} resolves to ${inside.address}, a private network address` : null;
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

/**
 * One request, retried when the connection itself fails (undici's `TypeError: fetch failed`:
 * reset, refused, DNS). A blocked URL, an HTTP status or the overall deadline is never retried.
 */
async function connect(url: string, allow: readonly string[] | undefined, init: RequestInit) {
  for (let attempt = 0; ; attempt++) {
    try {
      await checkUrl(url, allow);
      return await fetch(url, init);
    } catch (error) {
      const network = error instanceof TypeError || (error as { code?: string }).code === "EAI_AGAIN";
      if (!network || init.signal?.aborted || attempt >= NET.networkRetries) throw error;
      await new Promise((r) => setTimeout(r, NET.networkRetryMs * (attempt + 1)));
    }
  }
}

export async function guardedFetch(
  input: string,
  options: GuardedFetchOptions = {},
): Promise<GuardedResponse> {
  const maxBytes = options.maxBytes ?? NET.maxResponseBytes;
  // A cancelled run's downloads (its checkout, registry reads) end at once (U1 review).
  const limit = AbortSignal.timeout(options.timeoutMs ?? NET.timeoutMs);
  const run = cancelSignal();
  const deadline = run ? AbortSignal.any([limit, run]) : limit;
  // English pages, wherever the worker runs: quotes are checked against what the readers understand.
  const headers: Record<string, string> = {
    "user-agent": NET.userAgent,
    "accept-language": "en-US,en;q=0.9",
    ...options.headers,
  };
  if (options.etag) headers["if-none-match"] = options.etag;
  if (options.lastModified) headers["if-modified-since"] = options.lastModified;

  const redirects: string[] = [];
  let current = input;
  for (let hop = 0; hop <= NET.maxRedirects; hop++) {
    const response = await connect(current, options.allowHosts, {
      headers,
      redirect: "manual",
      signal: deadline,
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel();
      redirects.push(current);
      const nextUrl = new URL(response.headers.get("location") as string, current);
      // Credentials never follow a redirect to another host (GitHub's codeload URL carries its own token).
      if (nextUrl.host !== new URL(current).host) {
        delete headers.authorization;
        delete headers.cookie;
      }
      current = nextUrl.toString();
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
    if (options.stream) {
      // The body as it arrives, capped: a repository tarball never sits whole in memory (R17).
      const body = response.body;
      async function* capped() {
        let seen = 0;
        for await (const chunk of body ?? []) {
          seen += chunk.byteLength;
          if (seen > maxBytes) throw new BlockedUrlError(`response larger than ${maxBytes} bytes`);
          yield chunk;
        }
      }
      return {
        status: response.status,
        url: input,
        finalUrl: current,
        redirects,
        headers: response.headers,
        body: new Uint8Array(0),
        stream: capped(),
        text: () => "",
        json: <T>() => ({}) as T,
      };
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
