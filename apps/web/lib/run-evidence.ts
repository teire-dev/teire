/**
 * A run's evidence as links (revamp S1: every claim one click from its proof). Pure, so the run page's
 * client components share it: GitHub links at the run's own commit, the lines its diff changed, and
 * the pull request or issue text it proposed or published.
 */

/** A located use of what changed, as the scan or the run recorded it. */
export interface RunSite {
  file: string;
  line: number;
  snippet: string;
  kind: string | null;
}

/**
 * The lines a run reached: its own snapshot (`at: "run"`), or for a run that predates snapshots the
 * repository's latest scan (`at: "scan"`), linked at the commit that scan read.
 */
export interface RunCode {
  at: "run" | "scan" | null;
  sha: string | null;
  sites: RunSite[];
  total: number;
}

/**
 * The run's own snapshot of its lines (`assess`/`sites`) when its events have it, else what the first
 * load found: the poll streams events, so a run opened before it read the code shows the lines the
 * moment it does (review 2026-10-30).
 */
export function codeOf(events: { step: string; type: string; payload: unknown }[], loaded: RunCode): RunCode {
  const snapshot = events.findLast((e) => e.step === "assess" && e.type === "sites")?.payload as
    | { sha?: string; sites?: RunSite[]; total?: number }
    | undefined;
  if (!snapshot?.sites) return loaded;
  return {
    at: "run",
    sha: snapshot.sha ?? null,
    sites: snapshot.sites.slice(0, SITES_SHOWN),
    total: snapshot.total ?? snapshot.sites.length,
  };
}

const SITES_SHOWN = 40;

/** An upstream change the run answers, with every source it was read from. */
export interface RunChange {
  id: string;
  title: string;
  kind: string;
  sources: {
    url: string | null;
    quote: string | null;
    kind: string | null;
    trustBasis: string | null;
    checkedAt: string | null;
  }[];
}

const path = (file: string) => file.split("/").map(encodeURIComponent).join("/");

/** A file (and lines) on GitHub at a commit. */
export function blobUrl(repo: string, sha: string, file: string, line?: number, end?: number) {
  const range = line ? `#L${line}${end && end > line ? `-L${end}` : ""}` : "";
  return `https://github.com/${repo}/blob/${sha}/${path(file)}${range}`;
}

export const commitUrl = (repo: string, sha: string) => `https://github.com/${repo}/commit/${sha}`;
export const branchUrl = (repo: string, branch: string) => `https://github.com/${repo}/tree/${path(branch)}`;

const LOCKFILES =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|gradle\.lockfile)$/;
const MANIFESTS =
  /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.cfg|Pipfile|go\.mod|Cargo\.toml|Gemfile|[^/]+\.gemspec|pom\.xml|build\.gradle(\.kts)?|libs\.versions\.toml)$/;

/** One changed stretch of a file: the base commit's lines it replaced, and what replaced them. */
export interface Hunk {
  file: string;
  /** The base commit's first and last changed line (an insertion points at the line before it). */
  start: number;
  end: number;
  removed: string[];
  added: string[];
  role: "manifest" | "lockfile" | "code";
  /** A file the change created: there is nothing at the base commit to link to. */
  created: boolean;
}

/**
 * The stretches a unified diff changed, per file, with the base commit's line numbers counted through
 * each hunk so a link points at the changed lines themselves, not the hunk's context.
 */
export function hunksOf(patch: string | null): Hunk[] {
  if (!patch) return [];
  const out: Hunk[] = [];
  let file = "";
  let created = false;
  let old = 0;
  // Lines left in the current hunk, from its header's counts: inside a hunk, `--- x` is a removed
  // line that starts with "--" (a SQL comment), not a file header (review 2026-10-30).
  let oldLeft = 0;
  let newLeft = 0;
  let current: Hunk | null = null;
  const close = () => {
    if (current && (current.removed.length || current.added.length)) out.push(current);
    current = null;
  };
  for (const line of patch.split("\n")) {
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (!inHunk && line.startsWith("diff --git ")) {
      close();
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      close();
      created = line.slice(4).trim() === "/dev/null";
      if (!created) file = line.slice(4).trim().replace(/^a\//, "");
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const to = line.slice(4).trim();
      if (created && to !== "/dev/null") file = to.replace(/^b\//, "");
      continue;
    }
    const head = !inHunk && /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (head) {
      close();
      old = Number(head[1]);
      oldLeft = head[2] === undefined ? 1 : Number(head[2]);
      newLeft = head[3] === undefined ? 1 : Number(head[3]);
      continue;
    }
    if (inHunk) {
      if (line.startsWith(" ")) {
        oldLeft -= 1;
        newLeft -= 1;
      } else if (line.startsWith("-")) oldLeft -= 1;
      else if (line.startsWith("+")) newLeft -= 1;
    }
    if (!file || (!line.startsWith("-") && !line.startsWith("+") && !line.startsWith(" "))) continue;
    if (line.startsWith(" ")) {
      // Context ends a stretch of changes; the next change starts a new one.
      close();
      old += 1;
      continue;
    }
    const role: Hunk["role"] = LOCKFILES.test(file) ? "lockfile" : MANIFESTS.test(file) ? "manifest" : "code";
    current ??= {
      file,
      start: Math.max(1, old),
      end: Math.max(1, old),
      removed: [],
      added: [],
      role,
      created,
    };
    if (line.startsWith("-")) {
      current.removed.push(line.slice(1));
      current.end = old;
      old += 1;
    } else current.added.push(line.slice(1));
  }
  close();
  return out;
}

/** The text a run proposed (a dry run) or published (a pull request or issue). */
export interface RunPost {
  state: "proposed" | "published";
  kind: "pr" | "issue";
  title: string | null;
  body: string;
  url: string | null;
  number: number | null;
}

/**
 * The run's pull request or issue text from its events, newest first: a dry run's proposal, the body
 * a real run published, or one read back from GitHub for a run that predates storing it. Read from
 * events on the first load and on every poll, so a run that finishes while the page is open shows it.
 */
export function postOf(
  events: { step: string; type: string; payload: unknown }[],
  artifact: { kind: string; url: string | null; number: number | null } | null,
): RunPost | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.step !== "pr") continue;
    const p = (e.payload ?? {}) as {
      title?: string;
      body?: string;
      mode?: string;
      kind?: string;
      url?: string;
      number?: number;
    };
    if (typeof p.body !== "string" || !p.body.trim()) continue;
    const dry = e.type === "dry-run";
    const kind = dry
      ? p.mode === "issue"
        ? "issue"
        : "pr"
      : p.kind === "issue" || e.type === "issue"
        ? "issue"
        : "pr";
    return {
      state: dry ? "proposed" : "published",
      kind,
      title: p.title ?? null,
      body: p.body,
      url: p.url ?? (artifact?.kind === kind ? artifact.url : null),
      number: p.number ?? (artifact?.kind === kind ? artifact.number : null),
    };
  }
  return null;
}
