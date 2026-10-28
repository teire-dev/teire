import { sha256 } from "../catalog/source";
import { OPENAPI } from "../constants";
import { guardedFetch } from "../net/fetch";
import type { RegistryOptions } from "../registry/clients";

/**
 * Where a provider publishes its API description, found from deterministic facts (research
 * cross-cutting.md §5.2): the GitHub organisation that owns the provider's SDK holds a repository
 * named for it (`stripe/openapi`, `openai/openai-openapi`, `twilio/twilio-oai`,
 * `github/rest-api-description`, checked 2026-10-25), and the spec file in it is picked by name and
 * by the API host. A repo can name its own in `teire.yml` (`sources: [{host, specUrl}]`).
 * Revisions come from the repository's history: the spec as it was at a date, and the latest.
 */
export interface SpecLocation {
  /** `owner/name`. */
  repo: string;
  /** Path of the spec file in the repository. */
  path: string;
  branch: string;
}

export interface SpecRevision {
  sha: string;
  date: string;
  url: string;
}

interface GitHubOptions {
  githubToken?: string;
}

async function github<T>(path: string, options: GitHubOptions): Promise<T | null> {
  const res = await guardedFetch(`https://api.github.com${path}`, {
    allowHosts: ["api.github.com"],
    headers: {
      accept: "application/vnd.github+json",
      ...(options.githubToken ? { authorization: `Bearer ${options.githubToken}` } : {}),
    },
    maxBytes: 32 * 1024 * 1024,
  });
  if (res.status !== 200) return null;
  return res.json<T>();
}

/** Ranks spec-repository names: the plainest description repository first, generators last. */
function repoRank(name: string, owner: string) {
  const n = name.toLowerCase();
  if (/generator|codegen|sdk|client|mock|tools?$/.test(n)) return 9;
  if (n === "openapi" || n === `${owner.toLowerCase()}-openapi` || n === "rest-api-description") return 0;
  if (n.endsWith("-oai") || n.endsWith("-openapi") || n.startsWith("openapi")) return 1;
  return 2;
}

/** Ranks spec files: names that carry the API host, then the usual names; SDK and dereferenced variants last. */
export function fileRank(path: string, host: string) {
  const p = path.toLowerCase();
  if (
    !/\.(?:json|ya?ml)$/.test(p) ||
    /(^|\/)\.github\/|fixture|example|test|deref|\.sdk\.|beta|preview|package/.test(p)
  )
    return 99;
  const file = p.split("/").at(-1) ?? p;
  const labels = host.toLowerCase().split(".");
  const named = file.startsWith(host.toLowerCase())
    ? 0
    : labels[0] !== "api" && file.includes(labels[0] ?? "")
      ? 1
      : 5;
  const usual = /^(openapi|spec3|swagger|api)\.(json|ya?ml)$/.test(file)
    ? 0
    : /openapi|spec|oai/.test(p)
      ? 2
      : 4;
  const versioned = /\d{4}-\d{2}-\d{2}/.test(file) ? 1 : 0;
  return named * 10 + usual + versioned + (file.endsWith(".json") ? 0 : 0.5);
}

export async function findSpec(
  owner: string,
  host: string,
  options: RegistryOptions & GitHubOptions,
): Promise<SpecLocation | null> {
  const key = `${owner.toLowerCase()}:${host}`;
  const cached = await options.cache.get("openapi", key);
  const now = options.now ?? new Date();
  if (cached && now.getTime() - Date.parse(cached.fetchedAt) < OPENAPI.repoFreshForMs) {
    // Stored as `{ found }` so "searched, nothing there" is a value (the column is NOT NULL); older
    // rows hold the location itself.
    const data = cached.data as { found?: SpecLocation | null } | SpecLocation | null;
    return data && "found" in data ? (data.found ?? null) : ((data as SpecLocation | null) ?? null);
  }
  const q = encodeURIComponent(`org:${owner} ${OPENAPI.repoQuery}`);
  const search = await github<{
    items: { full_name: string; name: string; archived: boolean; default_branch: string }[];
  }>(`/search/repositories?q=${q}&sort=updated&per_page=10`, options);
  let found: SpecLocation | null = null;
  const repos = (search?.items ?? [])
    .filter((r) => !r.archived && repoRank(r.name, owner) < 9)
    .sort((a, b) => repoRank(a.name, owner) - repoRank(b.name, owner))
    .slice(0, 3);
  for (const r of repos) {
    const tree = await github<{ tree: { path: string; type: string; size?: number }[] }>(
      `/repos/${r.full_name}/git/trees/${encodeURIComponent(r.default_branch)}?recursive=1`,
      options,
    );
    const best = (tree?.tree ?? [])
      .filter((t) => t.type === "blob" && (t.size ?? 0) > 1000 && (t.size ?? 0) <= OPENAPI.maxSpecBytes)
      .map((t) => ({ path: t.path, rank: fileRank(t.path, host) }))
      .filter((t) => t.rank < 99)
      .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length)[0];
    if (best) {
      found = { repo: r.full_name, path: best.path, branch: r.default_branch };
      break;
    }
  }
  // A failed search (rate limit, outage) is not an answer: only a search that ran is remembered.
  if (search)
    await options.cache.put("openapi", key, {
      etag: null,
      lastModified: null,
      bodyHash: sha256(JSON.stringify(found)),
      data: { found },
      fetchedAt: now.toISOString(),
    });
  return found;
}

/** The spec file's last commit on or before `until` (the latest when omitted). */
export async function specRevision(
  location: SpecLocation,
  options: GitHubOptions,
  until?: string,
): Promise<SpecRevision | null> {
  const params = new URLSearchParams({ path: location.path, sha: location.branch, per_page: "1" });
  if (until) params.set("until", until);
  const commits = await github<{ sha: string; commit: { committer: { date: string } } }[]>(
    `/repos/${location.repo}/commits?${params}`,
    options,
  );
  const c = commits?.[0];
  if (!c) return null;
  return {
    sha: c.sha,
    date: c.commit.committer.date,
    url: `https://raw.githubusercontent.com/${location.repo}/${c.sha}/${location.path}`,
  };
}

/** The spec's text at a revision (raw file, size-capped, through the guarded fetch). */
export async function specText(url: string): Promise<string> {
  const host = new URL(url).hostname;
  const res = await guardedFetch(url, {
    allowHosts: [host],
    maxBytes: OPENAPI.maxSpecBytes,
    timeoutMs: 120_000,
  });
  if (res.status !== 200) throw new Error(`spec ${res.status}: ${url}`);
  return res.text();
}

/** The date a repo's last commit touched a file: where its calls to an unversioned API were written. */
export async function lastChangedAt(
  repo: { owner: string; name: string; sha: string },
  file: string,
  options: GitHubOptions,
): Promise<string | null> {
  const params = new URLSearchParams({ path: file, sha: repo.sha, per_page: "1" });
  const commits = await github<{ commit: { committer: { date: string } } }[]>(
    `/repos/${repo.owner}/${repo.name}/commits?${params}`,
    options,
  );
  return commits?.[0]?.commit.committer.date ?? null;
}
