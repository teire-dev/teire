import { type DependencyInstance, dependencyInstance } from "../contract";
import { runPythonHelper } from "../python/helper";

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

export async function readPythonInventory(repoDir: string): Promise<PyProject[]> {
  const { projects } = await runPythonHelper<{ projects: HelperProject[] }>("inventory", [repoDir]);
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
