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
}

interface HelperProject extends Omit<PyProject, "instances"> {
  instances: Record<string, unknown>[];
}

/** Folders the helper treats as Python projects, each with the Python the sandbox runs for it. */
function pythonsByRoot(tree: RepoTree) {
  const roots = new Set(
    tree
      .files()
      .filter((f) => /(^|\/)(pyproject\.toml|Pipfile|requirements[^/]*\.(txt|in))$/.test(f))
      .map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".")),
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
  return projects.map((p) => ({
    ...p,
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
