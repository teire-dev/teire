import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeJoin } from "./archive";

/** Read-only view of an extracted repository. Paths are repo-relative with `/` separators. */
export interface RepoTree {
  files(): string[];
  read(path: string): string | null;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "target",
  "vendor",
  "dist",
  "build",
  ".next",
]);
/** Files larger than this are never read as manifests or lockfiles. */
const MAX_READ_BYTES = 20 * 1024 * 1024;

export function directoryTree(root: string): RepoTree {
  let cache: string[] | null = null;
  const walk = (dir: string, prefix: string, out: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), rel, out);
      } else if (entry.isFile()) out.push(rel);
    }
  };
  return {
    files() {
      if (!cache) {
        cache = [];
        walk(root, "", cache);
        cache.sort();
      }
      return cache;
    },
    read(path) {
      const full = safeJoin(root, path);
      if (!full) return null;
      try {
        if (statSync(full).size > MAX_READ_BYTES) return null;
        return readFileSync(full, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** In-memory tree for tests and for files fetched one by one. */
export function memoryTree(files: Record<string, string>): RepoTree {
  const names = Object.keys(files).sort();
  return { files: () => names, read: (path) => files[path] ?? null };
}

/** `src/**`, `*.lock`, `services/api` (a plain path is a directory prefix) → a matcher on repo paths. */
export function globMatcher(globs: string[]) {
  const res = globs.map((g) => {
    const glob = g.replace(/^\.?\//, "").replace(/\/$/, "");
    if (!/[*?]/.test(glob)) return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")}(?:/|$)`);
    const body = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      // A trailing `**` is everything beneath; `**/` is any number of folders.
      .replace(/\*\*$/, "\u0001")
      .replace(/\*\*\/?/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: \u0000 is the placeholder `**/` was swapped for above
      .replace(/\u0000/g, "(?:.*/)?")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: \u0001 is the placeholder a trailing `**` was swapped for above
      .replace(/\u0001/g, ".*");
    return new RegExp(`^${body}(?:/|$)`);
  });
  return (path: string) => res.some((re) => re.test(path));
}

/** The tree a repo's `paths` / `ignorePaths` config leaves to scan (C8); manifests outside are unseen. */
export function scopedTree(tree: RepoTree, scope: { paths: string[]; ignorePaths: string[] }): RepoTree {
  if (!scope.paths.length && !scope.ignorePaths.length) return tree;
  const include = scope.paths.length ? globMatcher(scope.paths) : () => true;
  const exclude = scope.ignorePaths.length ? globMatcher(scope.ignorePaths) : () => false;
  const keep = (p: string) => include(p) && !exclude(p);
  return {
    files: () => tree.files().filter(keep),
    read: (path: string) => (keep(path) ? tree.read(path) : null),
  };
}
