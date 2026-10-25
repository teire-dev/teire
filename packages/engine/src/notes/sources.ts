import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../catalog/source";
import { SURFACE } from "../constants";
import { guardedFetch } from "../net/fetch";
import { getNpmVersion, type RegistryOptions } from "../registry/clients";
import { getPypiVersion } from "../registry/pypi";
import { npmScheme, pypiScheme, type VersionScheme } from "../registry/versions";
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
  trustBasis: "registry" | "source-repo";
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

  const repo = githubRepoOf(detail?.repository?.url);
  if (!repo) {
    notes.push("no GitHub repository in the package metadata");
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
];

/**
 * What the source repo says at the target's tag: a migration guide the package does not ship, the
 * changelog file when none came with the package (Python packages keep theirs in the repo), and
 * GitHub Releases when no changelog covers the range.
 */
async function gatherRepoNotes(input: {
  name: string;
  from: string;
  to: string;
  scheme: VersionScheme;
  repo: { owner: string; repo: string };
  directory: string;
  sources: NoteSource[];
  notes: string[];
  checkedAt: string;
  options: NotesOptions;
}) {
  const { repo, sources, notes, checkedAt, options, scheme, from, to } = input;
  const base = input.directory ? `${input.directory.replace(/\/$/, "")}/` : "";
  const tags = [`v${to}`, to, `${input.name}@${to}`, `${input.name}-${to}`, `${input.name}==${to}`];
  const atTag = async (path: string) => {
    for (const tag of tags) {
      const res = await github(
        `/repos/${repo.owner}/${repo.repo}/contents/${base}${path}?ref=${encodeURIComponent(tag)}`,
        options,
      ).catch(() => null);
      // A missing tag or file: the next tag spelling decides.
      if (res?.status === 200)
        return {
          text: res.text(),
          url: `https://github.com/${repo.owner}/${repo.repo}/blob/${tag}/${base}${path}`,
        };
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

  if (!sources.some((s) => s.kind === "changelog"))
    for (const path of REPO_CHANGELOGS) {
      const found = await atTag(path);
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

  // GitHub Releases only when no changelog entry covers the range.
  if (sources.some((s) => s.kind === "changelog" && (s.entries?.length ?? 0) > 0)) return;
  for (let page = 1; page <= 5; page++) {
    const res = await github(
      `/repos/${repo.owner}/${repo.repo}/releases?per_page=100&page=${page}`,
      options,
      "application/vnd.github+json",
    ).catch(() => null);
    if (res?.status !== 200) {
      notes.push(`GitHub releases: ${res ? `HTTP ${res.status}` : "unreachable"}`);
      break;
    }
    const releases =
      res.json<
        { tag_name: string; body: string | null; draft: boolean; prerelease: boolean; html_url: string }[]
      >();
    let older = false;
    for (const r of releases) {
      const version = r.tag_name.replace(
        new RegExp(`^(${input.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[-@=]+|v)`),
        "",
      );
      if (!scheme.valid(version) || r.draft || r.prerelease || !r.body) continue;
      if (scheme.compare(version, from) <= 0) {
        older = true;
        continue;
      }
      if (scheme.compare(version, to) > 0) continue;
      sources.push({
        kind: "release-notes",
        url: r.html_url,
        trustBasis: "source-repo",
        text: r.body,
        contentHash: sha256(r.body),
        checkedAt,
        entries: [{ version, heading: r.tag_name, body: r.body, start: 0, end: r.body.length }],
      });
    }
    if (older || releases.length < 100) break;
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
    urls.find(([k]) => /source|repo|code|github/i.test(k)) ?? urls.find(([, v]) => /github\.com/.test(v));
  const repo = githubRepoOf(preferred?.[1]) ?? urls.map(([, v]) => githubRepoOf(v)).find(Boolean) ?? null;
  if (!repo) {
    notes.push("no GitHub repository in the package's project URLs");
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
