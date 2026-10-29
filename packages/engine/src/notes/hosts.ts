import { guardedFetch } from "../net/fetch";

/**
 * Where a package's own repository lives, for its release notes (S16.5, D-11, D-12): GitHub, GitLab
 * or Bitbucket. Only these three public hosts are read: a self-hosted forge would be a host the
 * package's own metadata chose, so it is named in the run's notes and not fetched.
 */
export interface SourceRepo {
  host: "github" | "gitlab" | "bitbucket";
  /** GitLab groups nest (`group/sub`); GitHub and Bitbucket have one owner or workspace. */
  owner: string;
  repo: string;
}

const HOSTS: [RegExp, SourceRepo["host"]][] = [
  [/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#/?].*)?$/, "github"],
  [/gitlab\.com[/:]((?:[^/]+\/)*[^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/, "gitlab"],
  [/bitbucket\.org[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#/?].*)?$/, "bitbucket"],
];

/**
 * A repository from a URL or npm's shorthands (`user/repo`, `github:user/repo`, `gitlab:group/repo`,
 * `bitbucket:ws/repo`, the bare form meaning GitHub). Null for anything else.
 */
export function sourceRepoOf(url: string | null | undefined): SourceRepo | null {
  const v = (url ?? "").trim();
  if (!v) return null;
  const short = /^(github|gitlab|bitbucket):((?:[^/\s]+\/)*[^/\s]+)\/([^/\s#]+?)(?:\.git)?$/.exec(v);
  if (short?.[1] && short[2] && short[3])
    return { host: short[1] as SourceRepo["host"], owner: short[2], repo: short[3] };
  const bare = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(v);
  if (bare?.[1] && bare[2]) return { host: "github", owner: bare[1], repo: bare[2] };
  // A GitLab URL's tail (`/-/tree/main`, `/-/blob/…`) is never part of the project path.
  const cleaned = v.replace(/\/-\/.*$/, "").replace(/\/+$/, "");
  for (const [re, host] of HOSTS) {
    const m = re.exec(cleaned);
    if (m?.[1] && m[2]) return { host, owner: m[1], repo: m[2] };
  }
  return null;
}

/**
 * A Go module path's repository through its `go-import` meta tag (`?go-get=1`, go.dev/ref/mod#vcs-find),
 * the way `go get` finds it: vanity paths (`go.uber.org/zap` → github.com/uber-go/zap). Go's own
 * modules at go.googlesource.com read from their official GitHub mirrors (github.com/golang/<repo>).
 * Only the meta tag is read, over https, with a byte cap.
 */
export async function goImportRepo(
  modulePath: string,
): Promise<{ repo: SourceRepo; directory: string } | null> {
  const host = modulePath.split("/")[0] ?? "";
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
  const res = await guardedFetch(`https://${modulePath}?go-get=1`, {
    allowHosts: [host],
    maxBytes: 256 * 1024,
    timeoutMs: 15_000,
  }).catch(() => null);
  if (res?.status !== 200) return null;
  const meta = [...res.text().matchAll(/<meta\s+name=["']go-import["']\s+content=["']([^"']+)["']/gi)]
    .map((m) => (m[1] ?? "").trim().split(/\s+/))
    .find(
      ([prefix, vcs]) =>
        vcs === "git" && prefix && (modulePath === prefix || modulePath.startsWith(`${prefix}/`)),
    );
  if (!meta?.[0] || !meta[2]) return null;
  const directory = modulePath.slice(meta[0].length).replace(/^\//, "");
  const google = /^https:\/\/go\.googlesource\.com\/([\w.-]+)$/.exec(meta[2]);
  const repo = google?.[1]
    ? { host: "github" as const, owner: "golang", repo: google[1] }
    : sourceRepoOf(meta[2]);
  return repo ? { repo, directory } : null;
}

const MAX_NOTE_BYTES = 4 * 1024 * 1024;

/** A file at a ref on the repository's host, with the URL a person opens; null when it isn't there. */
export async function fileAt(
  repo: SourceRepo,
  ref: string | null,
  path: string,
  githubToken?: string,
): Promise<{ text: string; url: string } | null> {
  if (repo.host === "github") {
    const res = await guardedFetch(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
      {
        allowHosts: ["api.github.com"],
        maxBytes: MAX_NOTE_BYTES,
        headers: {
          accept: "application/vnd.github.raw+json",
          "x-github-api-version": "2022-11-28",
          ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
        },
      },
    ).catch(() => null);
    return res?.status === 200
      ? {
          text: res.text(),
          url: `https://github.com/${repo.owner}/${repo.repo}/blob/${ref ?? "HEAD"}/${path}`,
        }
      : null;
  }
  if (repo.host === "gitlab") {
    const project = encodeURIComponent(`${repo.owner}/${repo.repo}`);
    const res = await guardedFetch(
      `https://gitlab.com/api/v4/projects/${project}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref ?? "HEAD")}`,
      { allowHosts: ["gitlab.com"], maxBytes: MAX_NOTE_BYTES },
    ).catch(() => null);
    return res?.status === 200
      ? {
          text: res.text(),
          url: `https://gitlab.com/${repo.owner}/${repo.repo}/-/blob/${ref ?? "HEAD"}/${path}`,
        }
      : null;
  }
  const branch = ref ?? (await bitbucketMainBranch(repo));
  if (!branch) return null;
  const res = await guardedFetch(
    `https://api.bitbucket.org/2.0/repositories/${repo.owner}/${repo.repo}/src/${encodeURIComponent(branch)}/${path}`,
    { allowHosts: ["api.bitbucket.org"], maxBytes: MAX_NOTE_BYTES },
  ).catch(() => null);
  return res?.status === 200
    ? { text: res.text(), url: `https://bitbucket.org/${repo.owner}/${repo.repo}/src/${branch}/${path}` }
    : null;
}

async function bitbucketMainBranch(repo: SourceRepo) {
  const res = await guardedFetch(`https://api.bitbucket.org/2.0/repositories/${repo.owner}/${repo.repo}`, {
    allowHosts: ["api.bitbucket.org"],
  }).catch(() => null);
  return res?.status === 200
    ? (res.json<{ mainbranch?: { name?: string } }>().mainbranch?.name ?? null)
    : null;
}

export interface HostRelease {
  tag: string;
  body: string;
  url: string;
  prerelease: boolean;
}

/**
 * One page of the repository's releases, newest first: GitHub Releases or GitLab releases. Bitbucket
 * has none (null), and a failure says why.
 */
export async function releasesPage(
  repo: SourceRepo,
  page: number,
  githubToken?: string,
): Promise<{ releases: HostRelease[] } | { error: string } | null> {
  if (repo.host === "bitbucket") return null;
  if (repo.host === "github") {
    const res = await guardedFetch(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100&page=${page}`,
      {
        allowHosts: ["api.github.com"],
        maxBytes: MAX_NOTE_BYTES,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
        },
      },
    ).catch(() => null);
    if (res?.status !== 200)
      return { error: `GitHub releases: ${res ? `HTTP ${res.status}` : "unreachable"}` };
    return {
      releases: res
        .json<
          { tag_name: string; body: string | null; draft: boolean; prerelease: boolean; html_url: string }[]
        >()
        .filter((r) => !r.draft && r.body)
        .map((r) => ({ tag: r.tag_name, body: r.body as string, url: r.html_url, prerelease: r.prerelease })),
    };
  }
  const project = encodeURIComponent(`${repo.owner}/${repo.repo}`);
  const res = await guardedFetch(
    `https://gitlab.com/api/v4/projects/${project}/releases?per_page=100&page=${page}`,
    { allowHosts: ["gitlab.com"], maxBytes: MAX_NOTE_BYTES },
  ).catch(() => null);
  if (res?.status !== 200) return { error: `GitLab releases: ${res ? `HTTP ${res.status}` : "unreachable"}` };
  return {
    releases: res
      .json<
        {
          tag_name: string;
          description: string | null;
          upcoming_release?: boolean;
          _links?: { self?: string };
        }[]
      >()
      .filter((r) => r.description)
      .map((r) => ({
        tag: r.tag_name,
        body: r.description as string,
        url:
          r._links?.self ??
          `https://gitlab.com/${repo.owner}/${repo.repo}/-/releases/${encodeURIComponent(r.tag_name)}`,
        prerelease: r.upcoming_release === true,
      })),
  };
}
