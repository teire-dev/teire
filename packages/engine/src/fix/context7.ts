import semver from "semver";
import { FIX } from "../constants";
import { guardedFetch } from "../net/fetch";

/**
 * Version-pinned docs for the fix agent (D66, cross-cutting.md §9), over Context7's REST API:
 * find the library, prefer the one the package's own repo owns, use the indexed version nearest the
 * target (exact, else the nearest below, else the latest) and say which; a 200 whose body carries
 * `error` is a miss, never docs.
 */
interface Library {
  id: string;
  title?: string;
  trustScore?: number;
  versions?: string[];
}

export interface DocsLookup {
  libraryId: string | null;
  version: string | null;
  note: string;
  text: string;
}

async function context7(path: string, apiKey: string | undefined) {
  return guardedFetch(`https://context7.com/api${path}`, {
    allowHosts: ["context7.com"],
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    timeoutMs: 30_000,
  });
}

function nearestVersion(versions: string[], target: string) {
  const parsed = versions
    .map((v) => ({ raw: v, v: semver.coerce(v)?.version }))
    .filter((x): x is { raw: string; v: string } => !!x.v);
  const exact = parsed.find((x) => x.v === target);
  if (exact) return exact.raw;
  const below = parsed.filter((x) => semver.lte(x.v, target)).sort((a, b) => semver.rcompare(a.v, b.v))[0];
  return below?.raw ?? parsed.sort((a, b) => semver.rcompare(a.v, b.v))[0]?.raw ?? null;
}

async function context(libraryId: string, query: string, apiKey: string | undefined) {
  const res = await context7(
    `/v2/context?libraryId=${encodeURIComponent(libraryId)}&query=${encodeURIComponent(query)}&type=txt`,
    apiKey,
  );
  // Misses and moves come as JSON error bodies: 200 "no_snippets_found", 301 "library_redirected".
  const text = res.text();
  const error = /^\s*\{\s*"error"/.test(text)
    ? (JSON.parse(text) as { error: string; redirectUrl?: string })
    : null;
  return { status: res.status, text: error || res.status !== 200 ? "" : text, error };
}

export async function lookupDocs(input: {
  packageName: string;
  /** `owner/repo` of the package's source, to prefer the repo-owned library. */
  sourceRepo?: string;
  target: string;
  query: string;
  apiKey?: string;
}): Promise<DocsLookup> {
  const search = await context7(
    `/v2/libs/search?libraryName=${encodeURIComponent(input.sourceRepo?.split("/")[1] ?? input.packageName)}&query=${encodeURIComponent(input.query)}`,
    input.apiKey,
  );
  const body = search.status === 200 ? search.json<{ results?: Library[] } | Library[]>() : [];
  const libraries = Array.isArray(body) ? body : (body.results ?? []);
  // The repo-owned library first, even when search ranks others higher ("openai" → openai-python).
  const repoId = input.sourceRepo ? `/${input.sourceRepo.toLowerCase()}` : null;
  const owned = libraries.find((l) => l.id.toLowerCase() === repoId);
  let libraryId = owned?.id ?? repoId ?? libraries[0]?.id ?? null;
  if (!libraryId)
    return { libraryId: null, version: null, note: "Context7 has no library for this package", text: "" };
  let version = owned?.versions?.length ? nearestVersion(owned.versions, input.target) : null;
  let result = await context(version ? `${libraryId}/${version}` : libraryId, input.query, input.apiKey);
  if (result.error?.error === "library_redirected" && result.error.redirectUrl) {
    // Context7 moved the repo's docs elsewhere (openai-node → developers.openai.com, unversioned).
    libraryId = result.error.redirectUrl;
    version = null;
    result = await context(libraryId, input.query, input.apiKey);
  }
  if (!result.text && !repoId && libraries[0] && libraries[0].id !== libraryId) {
    libraryId = libraries[0].id;
    version = null;
    result = await context(libraryId, input.query, input.apiKey);
  }
  if (!result.text)
    return { libraryId, version, note: `Context7 has no snippets for ${libraryId}`, text: "" };
  const exact = version !== null && version.replace(/^v/, "") === input.target;
  return {
    libraryId,
    version,
    note:
      version === null
        ? `${libraryId} (not pinned to a version: read the migration notes for exact ${input.target} APIs)`
        : exact
          ? `${libraryId}/${version}`
          : `${libraryId}/${version} (nearest indexed version to ${input.target})`,
    text: result.text.slice(0, FIX.maxDocsChars),
  };
}
