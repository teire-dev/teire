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
