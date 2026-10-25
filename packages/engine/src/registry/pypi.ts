import { REGISTRY } from "../constants";
import { guardedFetch } from "../net/fetch";
import type { RegistryOptions } from "./clients";

/**
 * PyPI Index API (PEP 691 JSON, research python.md §3): every file with its sha256, upload time,
 * `requires-python` and yank reason, in one gzip-compressed, ETag-cached document. The deprecated
 * `releases` key of the JSON API is never used. The per-version JSON API gives `project_urls` and
 * `requires_dist` for the versions being compared.
 */
export interface PypiFile {
  filename: string;
  url: string;
  sha256: string;
  requiresPython: string | null;
  uploadTime: string | null;
  yanked: string | null;
  size: number;
}

export interface PypiIndex {
  name: string;
  versions: string[];
  files: PypiFile[];
  status: string | null;
}

interface IndexDocument {
  name: string;
  versions?: string[];
  files?: {
    filename: string;
    url: string;
    hashes?: { sha256?: string };
    "requires-python"?: string | null;
    "upload-time"?: string;
    yanked?: boolean | string;
    size?: number;
  }[];
  "project-status"?: { status?: string };
}

export async function getPypiIndex(name: string, options: RegistryOptions): Promise<PypiIndex | null> {
  const key = `index:${name}`;
  const now = options.now ?? new Date();
  const previous = await options.cache.get("pypi", key);
  if (previous && now.getTime() - new Date(previous.fetchedAt).getTime() < REGISTRY.depsDevTtlMs)
    return previous.data as PypiIndex;
  const res = await guardedFetch(`https://pypi.org/simple/${encodeURIComponent(name)}/`, {
    allowHosts: ["pypi.org"],
    maxBytes: REGISTRY.maxPackumentBytes,
    headers: { accept: "application/vnd.pypi.simple.v1+json" },
    etag: previous?.etag,
  });
  if (res.status === 304 && previous) return previous.data as PypiIndex;
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`PyPI index ${res.status} for ${name}`);
  const doc = res.json<IndexDocument>();
  const index: PypiIndex = {
    name: doc.name,
    versions: doc.versions ?? [],
    status: doc["project-status"]?.status ?? null,
    files: (doc.files ?? []).map((f) => ({
      filename: f.filename,
      url: f.url,
      sha256: f.hashes?.sha256 ?? "",
      requiresPython: f["requires-python"] ?? null,
      uploadTime: f["upload-time"] ?? null,
      yanked: f.yanked === true ? "" : typeof f.yanked === "string" ? f.yanked : null,
      size: f.size ?? 0,
    })),
  };
  await options.cache.put("pypi", key, {
    etag: res.headers.get("etag"),
    lastModified: null,
    bodyHash: "",
    data: index,
    fetchedAt: now.toISOString(),
  });
  return index;
}

/** Every file published for a version: its wheels (`name-1.0.0-…whl`) and sdist (`name-1.0.0.tar.gz`). */
export function versionFiles(index: PypiIndex, version: string) {
  return index.files.filter(
    (f) =>
      f.filename.includes(`-${version}-`) ||
      f.filename.endsWith(`-${version}.tar.gz`) ||
      f.filename.endsWith(`-${version}.zip`),
  );
}

/** Wheel filename → version (`anthropic-1.0.0-py3-none-any.whl` → `1.0.0`). */
export function wheelVersion(filename: string) {
  const parts = filename.replace(/\.whl$/, "").split("-");
  return parts.length >= 5 ? (parts[1] ?? null) : null;
}

/**
 * The wheel Teire reads for a version: pure Python first, then CPython 3.12 manylinux x86_64, then
 * any wheel. Sdists are never used here: building one runs the package's code.
 */
export function pickWheel(index: PypiIndex, version: string): PypiFile | null {
  const wheels = index.files.filter(
    (f) => f.filename.endsWith(".whl") && wheelVersion(f.filename) === version && f.sha256,
  );
  const score = (f: PypiFile) =>
    /-py3-none-any\.whl$/.test(f.filename)
      ? 0
      : /-cp312-.*manylinux.*x86_64\.whl$/.test(f.filename)
        ? 1
        : /-abi3-.*manylinux.*x86_64/.test(f.filename)
          ? 2
          : 3;
  return wheels.sort((a, b) => score(a) - score(b))[0] ?? null;
}

export interface PypiVersionDetail {
  projectUrls: Record<string, string>;
  requiresDist: string[];
  requiresPython: string | null;
  yanked: string | null;
}

export async function getPypiVersion(
  name: string,
  version: string,
  options: RegistryOptions,
): Promise<PypiVersionDetail | null> {
  const key = `version:${name}@${version}`;
  const cached = await options.cache.get("pypi", key);
  if (cached) return cached.data as PypiVersionDetail;
  const res = await guardedFetch(
    `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
    {
      allowHosts: ["pypi.org"],
    },
  );
  if (res.status !== 200) return null;
  const doc = res.json<{
    info: {
      project_urls?: Record<string, string> | null;
      requires_dist?: string[] | null;
      requires_python?: string | null;
      yanked?: boolean;
      yanked_reason?: string | null;
    };
  }>();
  const detail: PypiVersionDetail = {
    projectUrls: doc.info.project_urls ?? {},
    requiresDist: doc.info.requires_dist ?? [],
    requiresPython: doc.info.requires_python ?? null,
    yanked: doc.info.yanked ? (doc.info.yanked_reason ?? "") : null,
  };
  await options.cache.put("pypi", key, {
    etag: null,
    lastModified: null,
    bodyHash: "",
    data: detail,
    fetchedAt: new Date().toISOString(),
  });
  return detail;
}
