import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../catalog/source";
import type { DeclaredSource } from "../config";
import { JVM, RUST, SURFACE } from "../constants";
import { guardedFetch } from "../net/fetch";
import { getNpmVersion, type RegistryOptions } from "../registry/clients";
import { getPypiVersion } from "../registry/pypi";
import { gemVersions } from "../registry/rubygems";
import {
  cargoScheme,
  goScheme,
  mavenScheme,
  npmScheme,
  pypiScheme,
  rubygemsScheme,
  type VersionScheme,
} from "../registry/versions";
import { fileAt, goImportRepo, releasesPage, type SourceRepo, sourceRepoOf } from "./hosts";
import { type ChangelogEntry, sliceChangelog } from "./slicer";

/**
 * Release notes for one upgrade (research js-ts.md §3, cross-cutting.md §7): first what the
 * target's registry tarball ships (CHANGELOG, MIGRATION, already on disk from the surface diff),
 * then the source repo at the target tag (a migration guide the tarball leaves out: openai's
 * `5.0.0` entry only says "see MIGRATION.md"), then GitHub Releases when no changelog covers the
 * range. Every fetch goes through the guarded routine; every text keeps its URL and hash so a
 * quote can be checked against exactly what was read.
 */
export interface NoteSource {
  kind: "changelog" | "migration-guide" | "release-notes";
  url: string;
  trustBasis: "registry" | "source-repo" | "repo-config";
  text: string;
  contentHash: string;
  checkedAt: string;
  /** Changelog entries in the upgrade's range (changelogs only). */
  entries?: ChangelogEntry[];
}

export interface NotesOptions extends RegistryOptions {
  cacheDir?: string;
  /** GitHub token (installation token in the worker); without one the API allows 60 requests/h. */
  githubToken?: string;
}

const CHANGELOG_FILE = /^(CHANGELOG|CHANGES|HISTORY|RELEASES?|NEWS)(\.md|\.markdown)?$/i;
const GUIDE_FILE = /^(MIGRATION|MIGRATING|UPGRADING|UPGRADE)(_GUIDE|-GUIDE)?(\.md|\.markdown)?$/i;
const GUIDE_PATHS = ["MIGRATION.md", "UPGRADING.md", "MIGRATION_GUIDE.md", "docs/MIGRATION.md"];
const MAX_NOTE_BYTES = 4 * 1024 * 1024;

/** `git+https://github.com/openai/openai-node.git` → { owner, repo }. */
export function githubRepoOf(url: string | undefined | null) {
  const m = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:[#/].*)?$/.exec(url ?? "");
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

async function github(path: string, options: NotesOptions, accept = "application/vnd.github.raw+json") {
  return guardedFetch(`https://api.github.com${path}`, {
    allowHosts: ["api.github.com"],
    maxBytes: MAX_NOTE_BYTES,
    headers: {
      accept,
      "x-github-api-version": "2022-11-28",
      ...(options.githubToken ? { authorization: `Bearer ${options.githubToken}` } : {}),
    },
  });
}

export async function gatherNpmNotes(name: string, from: string, to: string, options: NotesOptions) {
  const checkedAt = new Date().toISOString();
  const sources: NoteSource[] = [];
  const notes: string[] = [];
  const detail = await getNpmVersion(name, to, options);
  const tarballUrl = detail?.dist.tarball ?? `https://registry.npmjs.org/${name}/${to}`;
  const dir = join(options.cacheDir ?? SURFACE.cacheDir, name, to, "package");

  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    notes.push(`${name}@${to} is not unpacked; tarball notes skipped`);
  }
  for (const file of files) {
    const kind = CHANGELOG_FILE.test(file) ? "changelog" : GUIDE_FILE.test(file) ? "migration-guide" : null;
    if (!kind) continue;
    const text = readFileSync(join(dir, file), "utf8");
    const source: NoteSource = {
      kind,
      url: `${tarballUrl}#${file}`,
      trustBasis: "registry",
      text,
      contentHash: sha256(text),
      checkedAt,
    };
    if (kind === "changelog") source.entries = sliceChangelog(text, npmScheme, from, to);
    sources.push(source);
  }

  // `repository` may be an object, a URL or a shorthand (`user/repo`, `gitlab:group/repo`); else `homepage`.
  const repo = sourceRepoOf(detail?.repository?.url) ?? sourceRepoOf(detail?.homepage);
  if (!repo) {
    notes.push("no GitHub, GitLab or Bitbucket repository in the package metadata");
    return { sources, notes };
  }
  await gatherRepoNotes({
    name,
    from,
    to,
    scheme: npmScheme,
    repo,
    directory: detail?.repository?.directory ?? "",
    sources,
    notes,
    checkedAt,
    options,
  });
  return { sources, notes };
}

const REPO_CHANGELOGS = [
  "CHANGELOG.md",
  "HISTORY.md",
  "CHANGES.md",
  "CHANGELOG.rst",
  "CHANGES.rst",
  "HISTORY.rst",
  "NEWS.md",
  // Ruby gems
  "History.md",
  "Changelog.md",
  "History.rdoc",
  "CHANGELOG.rdoc",
];

/**
 * What the source repo says at the target's tag: a migration guide the package does not ship, the
 * changelog file when none came with the package (Python packages keep theirs in the repo), and the
 * host's releases (GitHub, GitLab) when no changelog covers the range.
 */
async function gatherRepoNotes(input: {
  name: string;
  from: string;
  to: string;
  scheme: VersionScheme;
  repo: SourceRepo;
  directory: string;
  sources: NoteSource[];
  notes: string[];
  checkedAt: string;
  options: NotesOptions;
}) {
  const { repo, sources, notes, checkedAt, options, scheme, from, to } = input;
  const dir = input.directory.replace(/\/$/, "");
  const base = dir ? `${dir}/` : "";
  // `parent-5.5.0` and `release-…` are common on the JVM (research jvm.md Job 3); a Go module in a
  // subdirectory tags `sub/vX.Y.Z`; the rest are spellings S16.5 names (`name-vX`, `release/X`).
  const tags = [
    ...(dir ? [`${dir}/v${to}`] : []),
    `v${to}`,
    to,
    `${input.name}@${to}`,
    `${input.name}-${to}`,
    `${input.name}-v${to}`,
    `${input.name}==${to}`,
    `parent-${to}`,
    `release-${to}`,
    `release/${to}`,
    `release/v${to}`,
  ];
  const token = options.githubToken;
  const atTag = async (path: string) => {
    for (const tag of tags) {
      // A missing tag or file: the next tag spelling decides.
      const found = await fileAt(repo, tag, `${base}${path}`, token);
      if (found) return found;
    }
    return null;
  };

  if (!sources.some((s) => s.kind === "migration-guide"))
    for (const path of GUIDE_PATHS) {
      const found = await atTag(path);
      if (!found) continue;
      sources.push({
        kind: "migration-guide",
        url: found.url,
        trustBasis: "source-repo",
        text: found.text,
        contentHash: sha256(found.text),
        checkedAt,
      });
      break;
    }

  // No tag spelling matched: the default branch's changelog, sliced to the range, still says it.
  const atTagOrHead = async (path: string) =>
    (await atTag(path)) ?? (await fileAt(repo, null, `${base}${path}`, token));
  if (!sources.some((s) => s.kind === "changelog"))
    for (const path of REPO_CHANGELOGS) {
      const found = await atTagOrHead(path);
      if (!found) continue;
      sources.push({
        kind: "changelog",
        url: found.url,
        trustBasis: "source-repo",
        text: found.text,
        contentHash: sha256(found.text),
        checkedAt,
        entries: sliceChangelog(found.text, scheme, from, to),
      });
      break;
    }

  // The host's releases only when no changelog entry covers the range.
  if (sources.some((s) => s.kind === "changelog" && (s.entries?.length ?? 0) > 0)) return;
  const prefix = new RegExp(
    `^(${input.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[-@=]+|${dir ? `${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/` : ""}v|v)`,
  );
  for (let page = 1; page <= 5; page++) {
    const got = await releasesPage(repo, page, token);
    if (!got) break;
    if ("error" in got) {
      notes.push(got.error);
      break;
    }
    let older = false;
    for (const r of got.releases) {
      const version = r.tag.replace(prefix, "");
      if (!scheme.valid(version) || r.prerelease) continue;
      if (scheme.compare(version, from) <= 0) {
        older = true;
        continue;
      }
      if (scheme.compare(version, to) > 0) continue;
      sources.push({
        kind: "release-notes",
        url: r.url,
        trustBasis: "source-repo",
        text: r.body,
        contentHash: sha256(r.body),
        checkedAt,
        entries: [{ version, heading: r.tag, body: r.body, start: 0, end: r.body.length }],
      });
    }
    if (older || got.releases.length < 100) break;
  }
}

/** PyPI: the repo from `project_urls` (Source, Repository, Homepage, …), its notes at the target's tag. */
export async function gatherPypiNotes(name: string, from: string, to: string, options: NotesOptions) {
  const checkedAt = new Date().toISOString();
  const sources: NoteSource[] = [];
  const notes: string[] = [];
  const detail = await getPypiVersion(name, to, options);
  const urls = Object.entries(detail?.projectUrls ?? {});
  const preferred =
    urls.find(([k]) => /source|repo|code|github|gitlab/i.test(k)) ??
    urls.find(([, v]) => /github\.com|gitlab\.com|bitbucket\.org/.test(v));
  const repo = sourceRepoOf(preferred?.[1]) ?? urls.map(([, v]) => sourceRepoOf(v)).find(Boolean) ?? null;
  if (!repo) {
    notes.push("no GitHub, GitLab or Bitbucket repository in the package's project URLs");
    return { sources, notes };
  }
  await gatherRepoNotes({
    name,
    from,
    to,
    scheme: pypiScheme,
    repo,
    directory: "",
    sources,
    notes,
    checkedAt,
    options,
  });
  return { sources, notes };
}

/**
 * A Go module's notes: its path names its repository (`github.com/owner/repo[/sub][/vN]`); a module
 * in a subdirectory keeps its changelog there. Modules hosted elsewhere have no notes Teire reads.
 */
export async function gatherGoNotes(path: string, from: string, to: string, options: NotesOptions) {
  const checkedAt = new Date().toISOString();
  const sources: NoteSource[] = [];
  const notes: string[] = [];
  const base = path.replace(/\/v\d+$/, "");
  const m = /^(?:github\.com|gitlab\.com|bitbucket\.org)\/([^/]+)\/([^/]+)(?:\/(.+))?$/.exec(base);
  const host = base.split("/")[0];
  // A vanity path (`go.uber.org/zap`, `golang.org/x/net`) names its repository in a go-import tag.
  const found =
    m?.[1] && m[2]
      ? {
          repo: {
            host: host === "gitlab.com" ? "gitlab" : host === "bitbucket.org" ? "bitbucket" : "github",
            owner: m[1],
            repo: m[2],
          } as SourceRepo,
          directory: m[3] ?? "",
        }
      : await goImportRepo(base);
  if (!found) {
    notes.push(`${path} names no GitHub, GitLab or Bitbucket repository, here or in its go-import tag`);
    return { sources, notes };
  }
  await gatherRepoNotes({
    name: path,
    from,
    to,
    scheme: goScheme,
    repo: found.repo,
    directory: found.directory,
    sources,
    notes,
    checkedAt,
    options,
  });
  return { sources, notes };
}

/** A crate's notes: its repository from the crates.io API (≤ 1 request/s, identified), then the repo at the tag. */
export async function gatherCargoNotes(name: string, from: string, to: string, options: NotesOptions) {
  const checkedAt = new Date().toISOString();
  const sources: NoteSource[] = [];
  const notes: string[] = [];
  let repository: string | null = null;
  try {
    const res = await guardedFetch(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, {
      allowHosts: ["crates.io"],
      headers: { "user-agent": RUST.userAgent },
    });
    if (res.status === 200)
      repository = res.json<{ crate?: { repository?: string | null } }>().crate?.repository ?? null;
  } catch {
    // No repository link: no notes.
  }
  const repo = sourceRepoOf(repository);
  if (!repo) {
    notes.push("no GitHub, GitLab or Bitbucket repository on crates.io");
    return { sources, notes };
  }
  await gatherRepoNotes({
    name,
    from,
    to,
    scheme: cargoScheme,
    repo,
    directory: "",
    sources,
    notes,
    checkedAt,
    options,
  });
  return { sources, notes };
}

/**
 * A gem's notes (plan S07, research ruby.md Job 3): the repository from the target version's gemspec
 * links (source_code_uri, changelog_uri, homepage_uri); a changelog_uri pointing at a file in a
 * subdirectory (`rails/rails/blob/v8.1.4/actionmailer/CHANGELOG.md`) keeps that directory.
 */
export async function gatherRubyNotes(name: string, from: string, to: string, options: NotesOptions) {
  const checkedAt = new Date().toISOString();
  const sources: NoteSource[] = [];
  const notes: string[] = [];
  let error = "";
  const versions = await gemVersions(name).catch((e) => {
    error = e instanceof Error ? e.message : String(e);
    return [];
  });
  const links = (versions.find((v) => v.number === to) ?? versions[0])?.links ?? {};
  const repo = sourceRepoOf(links.source) ?? sourceRepoOf(links.changelog) ?? sourceRepoOf(links.homepage);
  if (!repo) {
    notes.push(
      error
        ? `RubyGems unreachable: ${error}`
        : "no GitHub, GitLab or Bitbucket repository in the gem's metadata",
    );
    return { sources, notes };
  }
  const file = /github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/.exec(links.changelog ?? "")?.[1];
  await gatherRepoNotes({
    name,
    from,
    to,
    scheme: rubygemsScheme,
    repo,
    directory: file?.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "",
    sources,
    notes,
    checkedAt,
    options,
  });
  return { sources, notes };
}

/**
 * A Maven artifact's notes (plan S08, research jvm.md Job 3): the repository from deps.dev's
 * SOURCE_REPO link, else the POM's `<scm><url>`; tags carry the release without a flavor
 * (`33.7.2-jre` is tagged `v33.7.2`), and GitHub follows a moved repository's redirect.
 */
export async function gatherJvmNotes(name: string, from: string, to: string, options: NotesOptions) {
  const checkedAt = new Date().toISOString();
  const sources: NoteSource[] = [];
  const notes: string[] = [];
  const [group, artifact] = name.split(":") as [string, string];
  let repoUrl: string | null = null;
  try {
    const res = await guardedFetch(
      `https://api.deps.dev/v3/systems/maven/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(to)}`,
      { allowHosts: ["api.deps.dev"] },
    );
    if (res.status === 200)
      repoUrl =
        res
          .json<{ links?: { label?: string; url?: string }[] }>()
          .links?.find((l) => l.label === "SOURCE_REPO")?.url ?? null;
  } catch {
    // The POM below.
  }
  // Else the POM's `<scm>`, walking up its `<parent>` chain (many artifacts inherit theirs), from
  // Central on every configured mirror (S16.5).
  if (!sourceRepoOf(repoUrl)) repoUrl = await pomScmUrl(group, artifact, to);
  const repo = sourceRepoOf(repoUrl);
  if (!repo) {
    notes.push("no GitHub, GitLab or Bitbucket repository in deps.dev or the POM chain");
    return { sources, notes };
  }
  await gatherRepoNotes({
    name: artifact,
    from,
    to: to.replace(/-(?:jre|android|jdk\d*|java\d*)$/i, ""),
    scheme: mavenScheme,
    repo,
    directory: "",
    sources,
    notes,
    checkedAt,
    options,
  });
  return { sources, notes };
}

/** A POM's `<scm><url>`, or its parent's, up to three levels, from the first mirror that has it. */
async function pomScmUrl(
  group: string,
  artifact: string,
  version: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 3) return null;
  let text: string | null = null;
  for (const mirror of JVM.mavenMirrors) {
    const res = await guardedFetch(
      `${mirror}/${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}.pom`,
      { allowHosts: [new URL(mirror).hostname] },
    ).catch(() => null);
    if (res?.status === 200) {
      text = res.text();
      break;
    }
  }
  if (!text) return null;
  const scm = /<scm>[\s\S]*?<url>\s*([^<]+?)\s*<\/url>/.exec(text)?.[1] ?? null;
  if (scm && sourceRepoOf(scm)) return scm;
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(text)?.[1];
  const tag = (name: string) => new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(parent ?? "")?.[1];
  const [g, a, v] = [tag("groupId"), tag("artifactId"), tag("version")];
  return g && a && v ? pomScmUrl(g, a, v, depth + 1) : scm;
}

/** A GitHub or GitLab file page as the raw file it shows; anything else unchanged. */
export function rawFileUrl(url: string) {
  return url
    .replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\//, "https://raw.githubusercontent.com/$1/$2/")
    .replace(/^(https:\/\/gitlab\.com\/.+?)\/-\/blob\//, "$1/-/raw/");
}

/**
 * The repository's own `teire.yml` source for a package (S16.1, `sources: [{package, changelogUrl}]`):
 * its changelog, fetched under the same rules as discovery (https, that host only, a byte cap) and
 * sliced to the range. It goes ahead of what discovery finds and is never public (D53). A GitHub or
 * GitLab file page is read as the raw file it shows.
 */
export async function declaredPackageNotes(
  declared: readonly DeclaredSource[] | undefined,
  name: string,
  from: string,
  to: string,
  scheme: VersionScheme,
): Promise<{ source: NoteSource | null; note: string | null }> {
  const d = declared?.find((s) => s.package === name && s.changelogUrl);
  if (!d?.changelogUrl) return { source: null, note: null };
  const raw = rawFileUrl(d.changelogUrl);
  const res = await guardedFetch(raw, {
    allowHosts: [new URL(raw).hostname],
    maxBytes: MAX_NOTE_BYTES,
  }).catch(() => null);
  if (res?.status !== 200)
    return {
      source: null,
      note: `teire.yml's changelog for ${name}: ${res ? `HTTP ${res.status}` : "unreachable"}`,
    };
  const text = res.text();
  return {
    source: {
      kind: "changelog",
      url: d.changelogUrl,
      trustBasis: "repo-config",
      text,
      contentHash: sha256(text),
      checkedAt: new Date().toISOString(),
      entries: sliceChangelog(text, scheme, from, to),
    },
    note: null,
  };
}
