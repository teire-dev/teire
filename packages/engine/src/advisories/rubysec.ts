import { gunzipSync } from "node:zlib";
import YAML from "yaml";
import { ADVISORIES } from "../constants";
import { guardedFetch } from "../net/fetch";
import { rubygemsScheme } from "../registry/versions";

/**
 * ruby-advisory-db (rubysec; plan S07, research ruby.md Job 9): the YAML database bundler-audit
 * reads, merged with OSV and GHSA because it holds advisories they lack (OSVDB-era entries, and
 * repo-level GHSAs the global API returns 404 for). The whole database is one ~600 KB tarball,
 * fetched when a Ruby repo is scanned and reused for an hour; it is data, no code runs. A version is
 * affected unless a `patched_versions` or `unaffected_versions` requirement admits it. OSVDB-era
 * text may be OSVDB's copyright: records cite and link the advisory, never copy its description.
 */
export interface RubysecAdvisory {
  gem: string;
  /** GHSA-…, else CVE-…, else OSVDB-…, else the file name. */
  id: string;
  aliases: string[];
  url: string;
  title: string;
  date: string | null;
  patched: string[];
  unaffected: string[];
  severity?: string;
}

interface RawAdvisory {
  gem?: string;
  cve?: string | number;
  ghsa?: string;
  osvdb?: string | number;
  url?: string;
  title?: string;
  date?: string | Date;
  cvss_v3?: number;
  cvss_v4?: number;
  cvss_v2?: number;
  patched_versions?: string[];
  unaffected_versions?: string[];
}

let memo: { at: number; byGem: Promise<Map<string, RubysecAdvisory[]>> } | null = null;

function severityOf(score: number | undefined) {
  if (score === undefined) return undefined;
  return score >= 9 ? "CRITICAL" : score >= 7 ? "HIGH" : score >= 4 ? "MODERATE" : "LOW";
}

/** Each `gems/<gem>/<id>.yml` entry of a gzipped tar (ustar names, with the prefix field). */
function* yamlEntries(gz: Uint8Array) {
  const tar = gunzipSync(gz);
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    const field = (start: number, len: number) =>
      Buffer.from(header.subarray(start, start + len))
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = field(0, 100);
    if (!name) break;
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const prefix = field(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const start = off + 512;
    const m = /\/gems\/([^/]+)\/([^/]+)\.ya?ml$/.exec(path);
    if (m?.[1] && m[2] && field(156, 1) !== "5")
      yield { gem: m[1], file: m[2], text: Buffer.from(tar.subarray(start, start + size)).toString("utf8") };
    off = start + Math.ceil(size / 512) * 512;
  }
}

async function load(): Promise<Map<string, RubysecAdvisory[]>> {
  const res = await guardedFetch(ADVISORIES.rubysecTarball, {
    allowHosts: ["codeload.github.com"],
    maxBytes: ADVISORIES.rubysecMaxBytes,
    timeoutMs: 60_000,
  });
  if (res.status !== 200) throw new Error(`ruby-advisory-db ${res.status}`);
  const byGem = new Map<string, RubysecAdvisory[]>();
  for (const e of yamlEntries(res.body)) {
    let raw: RawAdvisory;
    try {
      raw = YAML.parse(e.text) as RawAdvisory;
    } catch {
      continue;
    }
    const ghsa = raw.ghsa ? `GHSA-${String(raw.ghsa).replace(/^GHSA-/i, "")}` : null;
    const cve = raw.cve ? `CVE-${String(raw.cve).replace(/^CVE-/i, "")}` : null;
    const osvdb = raw.osvdb ? `OSVDB-${raw.osvdb}` : null;
    const ids = [ghsa, cve, osvdb].filter((x): x is string => !!x);
    const advisory: RubysecAdvisory = {
      gem: raw.gem ?? e.gem,
      id: ids[0] ?? e.file,
      aliases: ids.slice(1),
      url: raw.url ?? `https://github.com/rubysec/ruby-advisory-db/blob/master/gems/${e.gem}/${e.file}.yml`,
      title: raw.title ?? ids[0] ?? e.file,
      date: raw.date
        ? String(raw.date instanceof Date ? raw.date.toISOString().slice(0, 10) : raw.date)
        : null,
      patched: raw.patched_versions ?? [],
      unaffected: raw.unaffected_versions ?? [],
      ...(severityOf(raw.cvss_v4 ?? raw.cvss_v3 ?? raw.cvss_v2)
        ? { severity: severityOf(raw.cvss_v4 ?? raw.cvss_v3 ?? raw.cvss_v2) }
        : {}),
    };
    byGem.set(advisory.gem, [...(byGem.get(advisory.gem) ?? []), advisory]);
  }
  return byGem;
}

export function rubysecDatabase() {
  if (!memo || Date.now() - memo.at > ADVISORIES.rubysecTtlMs) {
    const byGem = load();
    memo = { at: Date.now(), byGem };
    byGem.catch(() => {
      memo = null;
    });
  }
  return memo.byGem;
}

/** Whether `version` is affected: no patched or unaffected requirement admits it. */
export function rubysecAffects(advisory: RubysecAdvisory, version: string) {
  const admits = (req: string) => {
    try {
      return rubygemsScheme.satisfies(version, req);
    } catch {
      return false;
    }
  };
  return !advisory.patched.some(admits) && !advisory.unaffected.some(admits);
}

/** Fixed versions named by the patched requirements (`~> 1.10.5`, `>= 2.0.0` → 1.10.5, 2.0.0). */
export function rubysecFixedIn(advisory: RubysecAdvisory) {
  return advisory.patched.flatMap((r) => /(\d+(?:\.\d+)*)/.exec(r)?.[1] ?? []);
}
