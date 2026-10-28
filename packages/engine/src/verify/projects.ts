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

/** The ecosystem a file belongs to by its name, when that is clear. */
const FILE_ECOSYSTEM: [RegExp, Ecosystem][] = [
  [/(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|[^/]+\.[cm]?[jt]sx?)$/, "npm"],
  [
    /(?:^|\/)(?:pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(?:\.lock)?|requirements[^/]*\.(?:txt|in)|[^/]+\.py)$/,
    "pypi",
  ],
  [/(?:^|\/)(?:go\.(?:mod|sum|work)|[^/]+\.go)$/, "go"],
  [/(?:^|\/)(?:Cargo\.(?:toml|lock)|[^/]+\.rs)$/, "cargo"],
  [/(?:^|\/)(?:Gemfile(?:\.lock)?|[^/]+\.(?:gemspec|rb))$/, "rubygems"],
  [/(?:^|\/)(?:pom\.xml|[^/]+\.gradle(?:\.kts)?|gradle\.lockfile|[^/]+\.(?:java|kt))$/, "maven"],
];

/** The ecosystem a file belongs to by its name, when that is clear. */
export function fileEcosystem(file: string): Ecosystem | undefined {
  return FILE_ECOSYSTEM.find(([re]) => re.test(file))?.[1];
}

/** A file that makes its folder a project of its own. */
export const PROJECT_MANIFEST =
  /(?:^|\/)(?:package\.json|pyproject\.toml|setup\.py|Pipfile|requirements\.txt|go\.mod|Cargo\.toml|Gemfile|[^/]+\.gemspec|pom\.xml|build\.gradle(?:\.kts)?)$/;

/**
 * The project a file belongs to: among the roots that contain it, the deepest one in the file's own
 * ecosystem (a root can hold a package.json and a pyproject.toml), else the deepest (review R2).
 */
export function projectOf<P extends { root: string; ecosystem?: string }>(
  projects: P[],
  file: string,
): P | null {
  const containing = projects
    .filter((p) => p.root === "." || file.startsWith(`${p.root}/`))
    .sort((a, b) => b.root.length - a.root.length);
  const ecosystem = FILE_ECOSYSTEM.find(([re]) => re.test(file))?.[1];
  return (ecosystem && containing.find((p) => p.ecosystem === ecosystem)) || containing[0] || null;
}

/** The plan for a project, with `teire.yml` `verify` overrides applied. */
export function planFor(
  project: CheckableProject,
  verify?: Parameters<typeof withVerifyOverrides>[2],
): CheckPlan {
  return withVerifyOverrides(project.plan(), project.root, verify);
}
