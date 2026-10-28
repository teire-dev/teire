import YAML from "yaml";
import type { RepoTree } from "../inventory/tree";

/**
 * The repo's CI jobs, each with the folder it runs in, so a monorepo's checks come from the job that
 * tests that project. A job's folder is its (or its workflow's) `defaults.run.working-directory`,
 * else the single folder its workflow's `paths:` filter names; none means the repo root.
 */
export interface CiStep {
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  "working-directory"?: string;
}

export interface CiJob {
  file: string;
  name: string;
  /** Repo-relative folder the job runs in, or null when it names none. */
  dir: string | null;
  steps: CiStep[];
  services?: Record<string, { image?: string }>;
  env?: Record<string, unknown>;
  strategy?: { matrix?: Record<string, unknown> };
}

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

const clean = (dir: string) => dir.replace(/^\.\//, "").replace(/\/+$/, "") || ".";

interface Workflow {
  on?: unknown;
  defaults?: { run?: { "working-directory"?: string } };
  jobs?: Record<
    string,
    Omit<CiJob, "file" | "name" | "dir"> & { defaults?: { run?: { "working-directory"?: string } } }
  >;
}

/** The one folder a workflow's `paths:` filters point at (`frontend/**`), if they agree on one. */
function pathsFolder(on: unknown): string | null {
  const triggers = on && typeof on === "object" ? Object.values(on as Record<string, unknown>) : [];
  const folders = new Set<string>();
  for (const t of triggers) {
    const paths = (t as { paths?: unknown } | null)?.paths;
    if (!Array.isArray(paths)) continue;
    for (const p of paths) {
      const m = /^([^*!{]+?)\/\*\*/.exec(String(p));
      if (m?.[1]) folders.add(clean(m[1]));
    }
  }
  return folders.size === 1 ? ([...folders][0] as string) : null;
}

export function ciJobs(tree: RepoTree): CiJob[] {
  const out: CiJob[] = [];
  for (const file of tree.files().filter((f) => WORKFLOW.test(f))) {
    let doc: Workflow;
    try {
      doc = (YAML.parse(tree.read(file) ?? "") ?? {}) as Workflow;
    } catch {
      continue;
    }
    const workflowDir = doc.defaults?.run?.["working-directory"] ?? pathsFolder(doc.on);
    for (const [name, job] of Object.entries(doc.jobs ?? {})) {
      const dir = job.defaults?.run?.["working-directory"] ?? workflowDir;
      out.push({
        file,
        name,
        dir: dir ? clean(dir) : null,
        steps: job.steps ?? [],
        ...(job.services ? { services: job.services } : {}),
        ...(job.env ? { env: job.env } : {}),
        ...(job.strategy ? { strategy: job.strategy } : {}),
      });
    }
  }
  return out;
}

/**
 * The jobs that test the project at `root`: those aimed at its folder (or a folder containing it),
 * and jobs aimed at no folder unless some job targets this project explicitly.
 */
export function ciJobsFor(tree: RepoTree, root: string): CiJob[] {
  const all = ciJobs(tree);
  const target = clean(root);
  const covers = (dir: string) => dir === target || dir === "." || target.startsWith(`${dir}/`);
  const aimed = all.filter((j) => j.dir !== null && j.dir !== "." && covers(j.dir));
  if (aimed.length) return aimed;
  return all.filter((j) => j.dir === null || j.dir === "." || covers(j.dir));
}

/** A step's `run:` lines, when the step runs in the project's folder (or names none). */
export function runLines(step: CiStep, root: string): string[] {
  if (typeof step.run !== "string") return [];
  const stepDir = step["working-directory"] ? clean(step["working-directory"]) : null;
  if (stepDir && stepDir !== clean(root) && stepDir !== ".") return [];
  return step.run
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
