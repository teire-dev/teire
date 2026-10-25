import semver from "semver";
import { sha256 } from "../catalog/source";
import { ADVISORIES } from "../constants";
import { type ChangeV2, changeV2, type Ecosystem, type Signature } from "../contract";
import { guardedFetch } from "../net/fetch";

/**
 * Security advisories for exact installed versions (card C2 step 4, D51), research
 * cross-cutting.md §2: OSV `querybatch` is the matcher (1,000 queries per call, no key, symbols
 * for Go and Rust); the GitHub Advisory Database is the cross-check, with withdrawn advisories
 * filtered out (OSV does not return them, GHSA does) and duplicates merged by alias. npm, PyPI,
 * Maven and RubyGems advisories carry no function names, so their reachability is "package
 * present" unless a later step can name the API (D74).
 */
export interface PackageQuery {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

const OSV_ECOSYSTEM: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
  maven: "Maven",
  go: "Go",
  cargo: "crates.io",
  rubygems: "RubyGems",
};
const GHSA_ECOSYSTEM: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "pip",
  maven: "maven",
  go: "go",
  cargo: "rust",
  rubygems: "rubygems",
};

interface OsvRange {
  type: string;
  events: { introduced?: string; fixed?: string; last_affected?: string }[];
}

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  modified?: string;
  published?: string;
  withdrawn?: string;
  affected?: {
    package?: { ecosystem?: string; name?: string };
    ranges?: OsvRange[];
    versions?: string[];
    ecosystem_specific?: {
      imports?: { path: string; symbols?: string[] }[];
      affects?: { functions?: string[] };
    };
    database_specific?: { source?: string };
  }[];
  database_specific?: { severity?: string };
  severity?: { type: string; score: string }[];
}

interface Ghsa {
  ghsa_id: string;
  cve_id: string | null;
  summary: string;
  severity: string;
  html_url: string;
  withdrawn_at: string | null;
  vulnerabilities: {
    package: { ecosystem: string; name: string };
    vulnerable_version_range: string | null;
    first_patched_version: string | null;
  }[];
}

async function osvGet<T>(path: string): Promise<T> {
  const res = await guardedFetch(`https://api.osv.dev${path}`, {
    allowHosts: ["api.osv.dev"],
    timeoutMs: 60_000,
    maxBytes: ADVISORIES.maxResponseBytes,
  });
  if (res.status !== 200) throw new Error(`OSV ${path}: ${res.status}`);
  return res.json<T>();
}

/** GHSA's `vulnerable_version_range` (`>= 4.0.0, <= 4.17.23`) as a check on one version; npm only for now. */
function ghsaRangeMatches(range: string | null, version: string, ecosystem: Ecosystem) {
  if (!range || ecosystem !== "npm") return true;
  const semverRange = range
    .replace(/,\s*/g, " ")
    .replace(/=\s+/g, "=")
    .replace(/([<>])\s+/g, "$1");
  return semver.validRange(semverRange) ? semver.satisfies(version, semverRange) : true;
}

/** POSTs through the global fetch: the guarded routine only GETs. The host is fixed, never input. */
async function osvBatch(queries: PackageQuery[]) {
  const res = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: queries.map((q) => ({
        package: { ecosystem: OSV_ECOSYSTEM[q.ecosystem], name: q.name },
        version: q.version,
      })),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`OSV querybatch ${res.status}`);
  const data = (await res.json()) as { results: { vulns?: { id: string }[] }[] };
  return data.results.map((r) => (r.vulns ?? []).map((v) => v.id));
}

async function ghsaFor(ecosystem: Ecosystem, packages: PackageQuery[], token?: string): Promise<Ghsa[]> {
  const out: Ghsa[] = [];
  for (let i = 0; i < packages.length; i += ADVISORIES.ghsaPackagesPerCall) {
    const affects = packages
      .slice(i, i + ADVISORIES.ghsaPackagesPerCall)
      .map((p) => `${p.name}@${p.version}`)
      .join(",");
    let url: string | null =
      `https://api.github.com/advisories?ecosystem=${GHSA_ECOSYSTEM[ecosystem]}&affects=${encodeURIComponent(affects)}&per_page=100`;
    for (let page = 0; url && page < 10; page++) {
      const res = await guardedFetch(url, {
        allowHosts: ["api.github.com"],
        maxBytes: ADVISORIES.maxResponseBytes,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.status !== 200) break;
      out.push(...res.json<Ghsa[]>());
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    }
  }
  return out;
}

/** Smallest fixed version on each release line, from OSV range events for this package. */
function fixedVersions(vuln: OsvVuln, ecosystem: Ecosystem, name: string) {
  const fixed = new Set<string>();
  for (const a of vuln.affected ?? []) {
    if (a.package?.name !== name || a.package?.ecosystem !== OSV_ECOSYSTEM[ecosystem]) continue;
    for (const r of a.ranges ?? [])
      if (r.type !== "GIT") for (const e of r.events) if (e.fixed) fixed.add(e.fixed);
  }
  return [...fixed];
}

function symbolsOf(vuln: OsvVuln, name: string): Signature[] {
  const out: Signature[] = [];
  for (const a of vuln.affected ?? []) {
    if (a.package?.name !== name) continue;
    const spec = a.ecosystem_specific;
    for (const imp of spec?.imports ?? [])
      for (const symbol of imp.symbols ?? [])
        out.push({
          kind: "symbol",
          lang: "go",
          declKey: `${imp.path}#${symbol}`,
          path: `${imp.path}.${symbol}`,
          memberKind: "function",
        });
    for (const fn of spec?.affects?.functions ?? [])
      out.push({ kind: "symbol", lang: "rust", declKey: fn, path: fn, memberKind: "function" });
  }
  return out;
}

export interface AdvisoryMatch {
  query: PackageQuery;
  record: ChangeV2;
}

/** Advisories that apply to the exact versions given, as security change records (one per advisory and package). */
export async function advisoriesFor(
  queries: PackageQuery[],
  options: { githubToken?: string } = {},
): Promise<AdvisoryMatch[]> {
  const unique = [...new Map(queries.map((q) => [`${q.ecosystem}:${q.name}@${q.version}`, q])).values()];
  const idsPer: string[][] = [];
  for (let i = 0; i < unique.length; i += ADVISORIES.osvBatchSize)
    idsPer.push(...(await osvBatch(unique.slice(i, i + ADVISORIES.osvBatchSize))));
  const allIds = [...new Set(idsPer.flat())];
  const vulns = new Map<string, OsvVuln>();
  for (let i = 0; i < allIds.length; i += ADVISORIES.detailConcurrency) {
    const batch = await Promise.all(
      allIds
        .slice(i, i + ADVISORIES.detailConcurrency)
        .map((id) => osvGet<OsvVuln>(`/v1/vulns/${encodeURIComponent(id)}`).catch(() => null)),
    );
    for (const v of batch) if (v && !v.withdrawn) vulns.set(v.id, v);
  }

  // GHSA cross-check per ecosystem: adds what OSV lacks, never withdrawn advisories.
  const ghsa = new Map<string, Ghsa[]>();
  for (const ecosystem of new Set(unique.map((q) => q.ecosystem))) {
    const list = await ghsaFor(
      ecosystem,
      unique.filter((q) => q.ecosystem === ecosystem),
      options.githubToken,
    ).catch(() => []);
    for (const g of list) {
      if (g.withdrawn_at) continue;
      for (const v of g.vulnerabilities) {
        const key = `${ecosystem}:${v.package.name}`;
        ghsa.set(key, [...(ghsa.get(key) ?? []), g]);
      }
    }
  }

  const checkedAt = new Date().toISOString();
  const matches: AdvisoryMatch[] = [];
  unique.forEach((query, index) => {
    const seen = new Set<string>();
    const add = (
      id: string,
      aliases: string[],
      summary: string,
      url: string,
      severity: string | undefined,
      fixedIn: string[],
      range: string | undefined,
      signatures: Signature[],
      body: string,
    ) => {
      if ([id, ...aliases].some((a) => seen.has(a))) return;
      for (const a of [id, ...aliases]) seen.add(a);
      const ghsaId = [id, ...aliases].find((a) => a.startsWith("GHSA-")) ?? id;
      matches.push({
        query,
        record: changeV2.parse({
          schemaVersion: 2,
          id: `advisory/${query.ecosystem}/${query.name}/${ghsaId}`,
          subject: { kind: "package", ecosystem: query.ecosystem, name: query.name },
          kind: "security-advisory",
          title: `${query.name}: ${summary || ghsaId}`.slice(0, 300),
          summary: `${summary || ghsaId}${severity ? ` (${severity.toLowerCase()})` : ""}. ${[id, ...aliases].join(", ")}.`,
          applicability: { class: "security", ...(range ? { affectedRange: range } : {}), fixedIn },
          signatures,
          sources: [
            {
              url,
              kind: "advisory",
              trustBasis: "advisory-db",
              ...(summary ? { quote: summary } : {}),
              contentHash: sha256(body),
              checkedAt,
            },
          ],
          provenance: { method: "advisory-feed", confidence: { overall: 1 } },
          visibility: "public",
          status: "confirmed",
        }),
      });
    };
    for (const id of idsPer[index] ?? []) {
      const v = vulns.get(id);
      if (!v) continue;
      add(
        v.id,
        v.aliases ?? [],
        v.summary ?? "",
        `https://osv.dev/vulnerability/${v.id}`,
        v.database_specific?.severity,
        fixedVersions(v, query.ecosystem, query.name),
        undefined,
        symbolsOf(v, query.name),
        JSON.stringify(v),
      );
    }
    for (const g of ghsa.get(`${query.ecosystem}:${query.name}`) ?? []) {
      const vuln = g.vulnerabilities.find((v) => v.package.name === query.name);
      if (!ghsaRangeMatches(vuln?.vulnerable_version_range ?? null, query.version, query.ecosystem)) continue;
      add(
        g.ghsa_id,
        g.cve_id ? [g.cve_id] : [],
        g.summary,
        g.html_url,
        g.severity,
        vuln?.first_patched_version ? [vuln.first_patched_version] : [],
        vuln?.vulnerable_version_range ?? undefined,
        [],
        JSON.stringify(g),
      );
    }
  });
  return matches;
}
