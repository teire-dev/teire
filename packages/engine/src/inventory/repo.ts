import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCAN } from "../constants";
import { guardedFetch } from "../net/fetch";
import { extractTarGz } from "./archive";

/**
 * A repository at one commit, as files on disk: the GitHub tarball (one request, no git) through the
 * guarded fetch, unpacked by Teire's own extractor. The pax header names the commit, so the scan
 * records exactly what it read. Private repos pass an installation token.
 */
export interface RepoCheckout {
  dir: string;
  sha: string | null;
  skipped: number;
}

export async function fetchRepoTarball(
  owner: string,
  repo: string,
  ref: string,
  options: { token?: string; dir?: string } = {},
): Promise<RepoCheckout> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(ref)}`;
  const res = await guardedFetch(url, {
    allowHosts: ["api.github.com", "codeload.github.com"],
    maxBytes: SCAN.maxTarballBytes,
    timeoutMs: 120_000,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
  });
  if (res.status !== 200) throw new Error(`GitHub tarball ${res.status} for ${owner}/${repo}@${ref}`);
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "teire-repo-")));
  const report = await extractTarGz(res.body, dir, { stripComponents: 1 });
  return { dir, sha: report.comment ?? null, skipped: report.skipped.length };
}
