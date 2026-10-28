import type { Ecosystem } from "../contract";
import { readGoInventory } from "../inventory/go";
import { readJsInventory } from "../inventory/js";
import { readJvmInventory } from "../inventory/jvm";
import { readPythonInventory } from "../inventory/python";
import { readRubyInventory } from "../inventory/ruby";
import { readRustInventory } from "../inventory/rust";
import type { RepoTree } from "../inventory/tree";
import type { CheckPlan } from "./commands";
import { detectJsChecks, withVerifyOverrides } from "./commands";
import { detectGoChecks } from "./go-commands";
import { detectJvmChecks } from "./jvm-commands";
import { detectPyChecks } from "./python-commands";
import { detectRubyChecks } from "./ruby-commands";
import { detectRustChecks } from "./rust-commands";

/** A project in any of the six ecosystems and the plan its own checks run by. */
export interface CheckableProject {
  root: string;
  ecosystem: Ecosystem;
  plan: () => CheckPlan;
}

/** Every project in the repository Teire can verify, whatever its ecosystem. */
export async function checkableProjects(repoDir: string, tree: RepoTree): Promise<CheckableProject[]> {
  return [
    ...readJsInventory(tree).map((p) => ({
      root: p.root,
      ecosystem: "npm" as const,
      plan: () => detectJsChecks(tree, p),
    })),
    ...(await readPythonInventory(repoDir, tree)).map((p) => ({
      root: p.root,
      ecosystem: "pypi" as const,
      plan: () => detectPyChecks(tree, p),
    })),
    ...(await readGoInventory(repoDir, tree)).map((p) => ({
      root: p.root,
      ecosystem: "go" as const,
      plan: () => detectGoChecks(tree, p),
    })),
    ...readRustInventory(tree).map((p) => ({
      root: p.root,
      ecosystem: "cargo" as const,
      plan: () => detectRustChecks(tree, p),
    })),
    ...readRubyInventory(tree).map((p) => ({
      root: p.root,
      ecosystem: "rubygems" as const,
      plan: () => detectRubyChecks(tree, p),
    })),
    ...readJvmInventory(tree).map((p) => ({
      root: p.root,
      ecosystem: "maven" as const,
      plan: () => detectJvmChecks(tree, p),
    })),
  ];
}

/** The project a file belongs to: the deepest root that contains it. */
export function projectOf<P extends { root: string }>(projects: P[], file: string): P | null {
  return (
    projects
      .filter((p) => p.root === "." || file.startsWith(`${p.root}/`))
      .sort((a, b) => b.root.length - a.root.length)[0] ?? null
  );
}

/** The plan for a project, with `teire.yml` `verify` overrides applied. */
export function planFor(
  project: CheckableProject,
  verify?: Parameters<typeof withVerifyOverrides>[2],
): CheckPlan {
  return withVerifyOverrides(project.plan(), project.root, verify);
}
