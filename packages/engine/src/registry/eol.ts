import { REGISTRY } from "../constants";
import { guardedFetch } from "../net/fetch";
import type { RegistryOptions } from "./clients";

/**
 * Runtime release lines and their support dates from endoflife.date API v1 (MIT data):
 * `GET /api/v1/products/<product>/` lists every line with release, end-of-active-support and
 * end-of-life dates. Cached a day per product.
 */
export interface RuntimeRelease {
  /** Release line as the product names it (`24`, `3.12`). */
  line: string;
  label: string;
  releasedOn: string | null;
  lts: boolean;
  /** End of active support (bug fixes); security fixes may continue. */
  activeSupportUntil: string | null;
  /** End of security support: no fixes of any kind after this date. */
  eolOn: string | null;
  maintained: boolean;
  latest: string | null;
}

export interface RuntimeProduct {
  product: string;
  label: string;
  releases: RuntimeRelease[];
  source: { url: string; checkedAt: string };
}

interface ProductDocument {
  result: {
    name: string;
    label: string;
    releases: {
      name: string;
      label: string;
      releaseDate?: string | null;
      isLts?: boolean;
      eoasFrom?: string | null;
      eolFrom?: string | null;
      isMaintained?: boolean;
      latest?: { name?: string } | null;
    }[];
  };
}

/** endoflife.date product ids for the runtimes Teire reads. */
export const RUNTIME_PRODUCTS = {
  node: "nodejs",
  python: "python",
  ruby: "ruby",
  go: "go",
  java: "eclipse-temurin",
} as const;

export async function getRuntimeProduct(
  product: string,
  options: RegistryOptions,
): Promise<RuntimeProduct | null> {
  const now = options.now ?? new Date();
  const cached = await options.cache.get("endoflife", product);
  if (cached && now.getTime() - new Date(cached.fetchedAt).getTime() < REGISTRY.endoflifeTtlMs)
    return cached.data as RuntimeProduct;
  const url = `https://${REGISTRY.hosts.endoflife}/api/v1/products/${encodeURIComponent(product)}/`;
  const res = await guardedFetch(url, {
    allowHosts: [REGISTRY.hosts.endoflife],
    etag: cached?.etag ?? undefined,
  });
  if (res.status === 304 && cached) return cached.data as RuntimeProduct;
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`endoflife.date ${res.status} for ${product}`);
  const doc = res.json<ProductDocument>();
  const data: RuntimeProduct = {
    product: doc.result.name,
    label: doc.result.label,
    releases: doc.result.releases.map((r) => ({
      line: r.name,
      label: r.label,
      releasedOn: r.releaseDate ?? null,
      lts: r.isLts ?? false,
      activeSupportUntil: r.eoasFrom ?? null,
      eolOn: r.eolFrom ?? null,
      maintained: r.isMaintained ?? false,
      latest: r.latest?.name ?? null,
    })),
    source: { url, checkedAt: now.toISOString() },
  };
  await options.cache.put("endoflife", product, {
    etag: res.headers.get("etag"),
    lastModified: null,
    bodyHash: "",
    data,
    fetchedAt: now.toISOString(),
  });
  return data;
}

/** The release line a version belongs to: the longest line that prefixes it (`3.12.4` → `3.12`, `22.11.0` → `22`). */
export function releaseLineOf(product: RuntimeProduct, version: string): RuntimeRelease | null {
  const matches = product.releases.filter((r) => version === r.line || version.startsWith(`${r.line}.`));
  return matches.sort((a, b) => b.line.length - a.line.length)[0] ?? null;
}
