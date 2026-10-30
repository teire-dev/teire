import { parse as parseToml } from "smol-toml";
import { type DependencyInstance, dependencyInstance } from "../contract";
import { runPythonHelper } from "../python/helper";
import { pythonFor } from "../verify/toolchains";
import { directoryTree, type RepoTree } from "./tree";

/**
 * Python inventory (plan S03, research python.md §2) through the helper: uv.lock, poetry.lock,
 * Pipfile.lock, pylock.toml and requirements files (recursive, `--hash` aware, remote includes never
 * followed), PEP 621/735, Poetry and Pipfile manifests, markers evaluated for Linux CPython 3.12.
 * Versions come only from locks or exact pins; anything else is unresolved (rule 12).
 */
export type PyManager = "uv" | "poetry" | "pipenv" | "pip-tools" | "uv-pip" | "pip" | "pylock" | "unknown";

export interface PyProject {
  root: string;
  manager: PyManager;
  lockfile: string | null;
  lockfileVersion: string | null;
  manifest: string | null;
  instances: DependencyInstance[];
  /** uv's `exclude-newer` (S18.5): nothing published after it resolves, so nothing after is proposed. */
  excludeNewer?: { date: string; source: string };
  /** Manifests whose runtime ranges widen (S18.5: a published library), set by the scan. */
  widen?: string[];
}

interface HelperProject extends Omit<PyProject, "instances" | "excludeNewer" | "widen"> {
  instances: Record<string, unknown>[];
}

/** Folders the helper treats as Python projects, each with the Python the sandbox runs for it. */
function pythonsByRoot(tree: RepoTree) {
  // The helper's own project folders: a pyproject, Pipfile, setup.py/.cfg or requirements file's
  // folder, and a `requirements/` folder's parent (S18 review R4).
  const parent = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".");
  const roots = new Set(
    tree.files().flatMap((f) => {
      if (/(^|\/)requirements\/[^/]+\.(txt|in)$/.test(f)) return [parent(parent(f))];
      return /(^|\/)(pyproject\.toml|Pipfile|setup\.py|setup\.cfg|requirements[^/]*\.(txt|in))$/.test(f)
        ? [parent(f)]
        : [];
    }),
  );
  const out: Record<string, string> = {};
  for (const root of roots) {
    const pick = pythonFor(tree, root);
    if (pick) out[root] = pick.version;
  }
  return out;
}

export async function readPythonInventory(repoDir: string, tree?: RepoTree): Promise<PyProject[]> {
  // Environment markers (`python_version < "3.11"`) are evaluated for the Python each project runs
  // on, the same pick the sandbox and the target filter use (D-38).
  const pythons = pythonsByRoot(tree ?? directoryTree(repoDir));
  const { projects } = await runPythonHelper<{ projects: HelperProject[] }>("inventory", [
    repoDir,
    JSON.stringify(pythons),
  ]);
  const view = tree ?? directoryTree(repoDir);
  return projects.map((p) => ({
    ...p,
    ...(() => {
      const ceiling = uvExcludeNewer(view, p.root);
      return ceiling ? { excludeNewer: ceiling } : {};
    })(),
    instances: p.instances.flatMap((raw) => {
      // `url` sources (a direct wheel URL) are neither registry nor path; the contract calls them unknown.
      const parsed = dependencyInstance.safeParse({
        ...raw,
        source: raw.source === "url" ? "unknown" : raw.source,
      });
      return parsed.success ? [parsed.data] : [];
    }),
  }));
}

/**
 * uv's `exclude-newer` for a project (S18.5): `[tool.uv]` in pyproject.toml, or uv.toml. An RFC 3339
 * timestamp, a date (taken at its start, the stricter reading), or a span back from now (`1 week`,
 * `P7D`). Null when unset or unreadable.
 */
export function uvExcludeNewer(tree: RepoTree, root: string, now = new Date()) {
  const at = (f: string) => (root === "." ? f : `${root}/${f}`);
  const read = (file: string, pick: (doc: Record<string, unknown>) => unknown) => {
    const text = tree.read(at(file));
    if (text === null) return null;
    try {
      const value = pick(parseToml(text) as Record<string, unknown>);
      return typeof value === "string" ? { value, file: at(file) } : null;
    } catch {
      return null;
    }
  };
  const found =
    read("uv.toml", (d) => d["exclude-newer"]) ??
    read(
      "pyproject.toml",
      (d) =>
        ((d.tool as Record<string, unknown> | undefined)?.uv as Record<string, unknown> | undefined)?.[
          "exclude-newer"
        ],
    );
  if (!found) return null;
  const v = found.value.trim();
  const source = `uv exclude-newer in ${found.file}`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)))
    return { date: new Date(v).toISOString(), source };
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: `${v}T00:00:00.000Z`, source };
  const span = /^(\d+)\s*(day|week)s?$/i.exec(v) ?? /^P(\d+)([DW])$/i.exec(v);
  if (span) {
    const days = Number(span[1]) * (/^w/i.test(span[2] ?? "") ? 7 : 1);
    return { date: new Date(now.getTime() - days * 86_400_000).toISOString(), source };
  }
  return null;
}
