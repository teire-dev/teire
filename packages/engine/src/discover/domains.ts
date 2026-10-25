import { isIP } from "node:net";
import { parse } from "tldts";

/**
 * Hosts and domains for provider discovery. A provider is known by the registrable domain of the API
 * host its code or SDK calls (`api.groq.com` → `groq.com`), computed with the public suffix list,
 * never by a suffix-string check (`stripe.com.evil.io` → `evil.io`).
 */
export function registrableDomain(host: string): string | null {
  if (!host || isIP(host)) return null;
  const parsed = parse(host, { allowPrivateDomains: true });
  return parsed.isIp ? null : (parsed.domain ?? null);
}

/** Code hosts and package registries: their links point at a repository or an index, not a provider's site. */
const CODE_HOSTS = new Set([
  "github.com",
  "githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "npmjs.com",
  "npmjs.org",
  "pypi.org",
  "pythonhosted.org",
  "rubygems.org",
  "crates.io",
  "docs.rs",
  "pkg.go.dev",
  "go.dev",
  "maven.org",
  "jsdelivr.net",
  "unpkg.com",
]);

/** Reserved names, standards bodies and schema hosts: never an API a repo depends on. */
const NOT_APIS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "w3.org",
  "json-schema.org",
  "schema.org",
  "ietf.org",
  "iana.org",
  "mozilla.org",
  "apache.org",
  "opensource.org",
  "creativecommons.org",
]);

const LOCAL_TLD = /\.(?:local|localhost|internal|test|example|invalid|lan|home)$/i;

/**
 * Whether a URL names an API endpoint: a host with an `api` label (`api.groq.com`,
 * `api-inference.together.ai`) or a versioned or `/api` path. Documentation, images and repository
 * links are not APIs; neither are private, local or reserved hosts.
 */
export function isApiEndpoint(host: string, path = "/") {
  const h = host.toLowerCase();
  if (h === "localhost" || LOCAL_TLD.test(h)) return false;
  const domain = registrableDomain(h);
  if (!domain || NOT_APIS.has(domain)) return false;
  const labels = h
    .slice(0, h.length - domain.length)
    .split(".")
    .filter(Boolean);
  if (labels.some((l) => l === "api" || l.startsWith("api-") || l.endsWith("-api"))) return true;
  return /^\/(?:api|v\d+(?:\.\d+)?(?:beta|alpha)?|openai\/v\d+)(?:\/|$)/i.test(path);
}

/** A link from a package's own metadata as an allowlist entry: the registrable domain, or a repo path prefix on a code host. */
export function linkScope(url: string): { domain: string } | { repoPrefix: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/^git\+/, "").replace(/\.git$/, ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const domain = registrableDomain(parsed.hostname);
  if (!domain || NOT_APIS.has(domain)) return null;
  if (domain === "github.com") {
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    return owner && repo ? { repoPrefix: `github.com/${owner}/${repo}` } : null;
  }
  if (CODE_HOSTS.has(domain)) return null;
  return { domain };
}

/** `groq.com` → "Groq"; `together.ai` → "Together". A provider's own name replaces it when a page gives one. */
export function nameFromDomain(domain: string) {
  const label = domain.split(".")[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}
