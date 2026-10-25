import { CATALOG_SCHEMA_VERSION, type ProviderRecord, providerRecord, slugify } from "../catalog/schema";
import { DISCOVERY } from "../constants";
import { guardedFetch } from "../net/fetch";
import { linkScope, nameFromDomain } from "./domains";
import type { SdkProfile } from "./sdk";
import { type TavilyUsage, tavilySearch } from "./tavily";

/**
 * Finding a provider's own notice pages when Teire has no reader for it (plan S04, D82, research
 * cross-cutting.md §8). Everything that decides where to look is deterministic: the registrable domain
 * of the API host the repo or its SDK calls, and the homepage, docs and repository links the SDK's
 * own metadata declares. Within that allowlist:
 *   1. the provider's `llms.txt` (on `docs.<domain>`, the domain itself, or the host a docs link
 *      redirects to) lists its pages; links whose URL or title says deprecations, retirements or
 *      changelog are candidates;
 *   2. when that names no deprecations page, Tavily searches restricted to the allowlist
 *      (`include_domains`, restrict mode) and nominates more.
 * Every candidate URL is checked again here (HTTPS, registrable domain on the allowlist), and the
 * page is later fetched by Teire itself, each redirect hop checked, before anything is read from it.
 */
export interface ProviderCandidate {
  /** Registrable domain of the API host (`groq.com`). */
  domain: string;
  /** API hosts seen in the repo's code or its SDKs' code. */
  hosts: string[];
  /** Installed SDKs whose own code calls one of those hosts. */
  sdks: SdkProfile[];
  /** Why the repo uses it: `npm:groq-sdk`, `api.groq.com`. */
  via: string[];
}

export interface Discovery {
  record: ProviderRecord | null;
  /** Tavily calls made (none when llms.txt was enough, or the result came from the cache). */
  usage: TavilyUsage[];
  /** Why no page was found, for the scan log. */
  note?: string;
  /** The search itself failed: nothing is cached, the next scan tries again. */
  transient?: boolean;
}

const DEPRECATIONS = /deprecat|retire|retirement|sunset|lifecycle|end-of-life|\beol\b|decommission|shutdown/i;
const CHANGELOG = /changelog|release-notes|release_notes|whats-new|what-s-new|breaking/i;

function score(url: string, title: string) {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return 0;
  }
  if (DEPRECATIONS.test(path)) return 6;
  if (DEPRECATIONS.test(title)) return 5;
  if (CHANGELOG.test(path)) return 3;
  if (CHANGELOG.test(title)) return 2;
  return 0;
}

/** The domains and repository prefixes whose pages count as the provider's own words. */
export function allowlistOf(candidate: Pick<ProviderCandidate, "domain" | "sdks">) {
  const domains = new Set([candidate.domain]);
  const repos = new Set<string>();
  for (const sdk of candidate.sdks)
    for (const link of sdk.links) {
      const scope = linkScope(link);
      if (!scope) continue;
      if ("domain" in scope) domains.add(scope.domain);
      else repos.add(scope.repoPrefix);
    }
  return { domains: [...domains], repos: [...repos] };
}

function onAllowlist(url: string, domains: string[]) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname;
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * Markdown links in an llms.txt: `- [Title](url): description`. Only the title counts: descriptions
 * mention deprecations in passing (Groq's models page "…categorized into production, preview and
 * deprecated models"), which would nominate the wrong page.
 */
export function llmsLinks(text: string) {
  const out: { url: string; title: string }[] = [];
  for (const m of text.matchAll(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g))
    out.push({ title: (m[1] ?? "").trim(), url: m[2] ?? "" });
  return out;
}

/** The first `# Heading` of an llms.txt names the provider (`# Mistral AI`), unless it is a URL. */
function nameFrom(text: string) {
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  return heading && !/https?:\/\//.test(heading) && heading.length <= 40
    ? heading.replace(/\s+(?:docs|documentation|llms\.txt)$/i, "")
    : null;
}

async function readLlmsTxt(host: string, domains: string[]) {
  const allowHosts = domains.flatMap((d) => [d, `.${d}`]);
  try {
    const res = await guardedFetch(`https://${host}/llms.txt`, { allowHosts, maxBytes: 4 * 1024 * 1024 });
    const type = res.headers.get("content-type") ?? "";
    if (res.status !== 200) return { links: [], finalHost: new URL(res.finalUrl).hostname, name: null };
    const finalHost = new URL(res.finalUrl).hostname;
    // A docs host that redirects to an HTML page (docs.groq.com → console.groq.com/docs) has no llms.txt here.
    if (!/text\/(?:plain|markdown)/.test(type)) return { links: [], finalHost, name: null };
    const text = res.text();
    return { links: llmsLinks(text), finalHost, name: nameFrom(text) };
  } catch {
    return { links: [], finalHost: null, name: null };
  }
}

export async function discoverProvider(candidate: ProviderCandidate, now = new Date()): Promise<Discovery> {
  const { domains, repos } = allowlistOf(candidate);
  const usage: TavilyUsage[] = [];
  const found = new Map<string, { url: string; title: string; score: number; via: "llms.txt" | "tavily" }>();
  const add = (url: string, title: string, via: "llms.txt" | "tavily") => {
    const clean = url.replace(/#.*$/, "");
    const s = score(clean, title);
    if (s === 0 || !onAllowlist(clean, domains)) return;
    const known = found.get(clean);
    if (!known || known.score < s) found.set(clean, { url: clean, title, score: s, via });
  };

  // 1. llms.txt: the docs host, the domain, the hosts the SDK's links point at, and where a docs host redirects.
  const linkHosts = candidate.sdks
    .flatMap((s) => s.links)
    .flatMap((l) => {
      try {
        const h = new URL(l).hostname;
        return onAllowlist(`https://${h}/`, domains) ? [h] : [];
      } catch {
        return [];
      }
    });
  const tried = new Set<string>();
  const queue = [...new Set([`docs.${candidate.domain}`, candidate.domain, ...linkHosts])];
  let name: string | null = null;
  while (queue.length && tried.size < 6) {
    const host = queue.shift() as string;
    if (tried.has(host)) continue;
    tried.add(host);
    const read = await readLlmsTxt(host, domains);
    name ??= read.name;
    for (const link of read.links) add(link.url, link.title, "llms.txt");
    if (read.finalHost && !tried.has(read.finalHost) && read.finalHost !== host) queue.push(read.finalHost);
  }

  // 2. Tavily, restricted to the allowlist, when llms.txt named no deprecations page.
  const displayName = name ?? nameFromDomain(candidate.domain);
  let query: string | undefined;
  if (![...found.values()].some((f) => f.score >= 5)) {
    query = `${displayName} API deprecations: retired models and endpoints, shutdown dates and replacements`;
    try {
      const search = await tavilySearch(query, [...domains, ...repos]);
      usage.push(search.usage);
      for (const r of search.results) add(r.url, r.title, "tavily");
    } catch (error) {
      if (!found.size)
        return {
          record: null,
          usage,
          note: `search failed: ${error instanceof Error ? error.message : error}`,
          transient: true,
        };
    }
  }

  const pages = [...found.values()]
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length)
    .slice(0, DISCOVERY.maxPagesPerProvider);
  if (!pages.length) return { record: null, usage, note: `no notice page found on ${domains.join(", ")}` };

  const record = providerRecord.parse({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    slug: slugify(candidate.domain),
    name: displayName,
    homepage: `https://${candidate.domain}`,
    logo: { light: "/logos/provider.svg", dark: "/logos/provider.svg" },
    officialDomains: domains,
    sources: pages.map((p) => ({
      kind: p.score >= 5 ? "deprecations" : "changelog",
      url: p.url,
      adapter: "discovered",
    })),
    sdks: candidate.sdks.map((s) => ({ ecosystem: s.ecosystem, name: s.name })),
    detection: { imports: [], envVars: [], baseUrls: candidate.hosts, calls: [] },
    discovery: {
      at: now.toISOString(),
      via: [...new Set(pages.map((p) => p.via))],
      ...(query ? { query } : {}),
      tavilyCredits: usage.reduce((n, u) => n + u.credits, 0),
      evidence: candidate.via,
    },
  });
  return { record, usage };
}
