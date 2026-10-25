import YAML from "yaml";
import type { JsManager, JsProject } from "../inventory/js";
import type { RepoTree } from "../inventory/tree";
import type { CheckName } from "./evidence";

/**
 * What to run for a JS project (research js-ts.md §8), in this order: the repo's CI steps, then
 * package.json scripts, then defaults (`tsc --noEmit`, `vitest run`, `jest --ci`). Watch modes,
 * e2e/integration suites, lint and formatting are left out: they need browsers or credentials,
 * or say nothing about an API break. Where the test script is a plain vitest or jest call, Teire
 * adds a JSON report for the test-count gate; otherwise it reads the runner's summary line.
 */
export interface PlannedCheck {
  name: CheckName;
  argv: string[];
  source: "ci" | "script" | "default";
  /** Where the runner writes its report, when one was requested. */
  reportPath?: string;
  /** jest/vitest JSON (default) or JUnit XML (pytest). */
  reportFormat?: "json" | "junit";
}

export interface CheckPlan {
  manager: string;
  /** Sandbox image with this ecosystem's toolchain (`node`, `python`, `go`, `rust`). */
  image: string;
  /** Instance size: compiled ecosystems (Rust, JVM) need `standard-3` (plan, sandbox measurements). */
  instance?: "standard-1" | "standard-2" | "standard-3" | "standard-4";
  /** Exact package-manager version the repo pins (`packageManager`), run through corepack. */
  managerVersion?: string;
  /** Working directory inside the sandbox checkout. */
  cwd: string;
  install: string[];
  /** Environment for the install (e.g. keep virtualenvs inside the project). */
  installEnv?: Record<string, string>;
  /** Environment for check commands (offline-safe settings). */
  env: Record<string, string>;
  checks: PlannedCheck[];
  /** Managers Teire has proven offline (npm, pnpm); the rest are labelled unverified. */
  provenOffline: boolean;
  /** Run the install once on the unchanged repo in the after side, before the change is written (JVM). */
  warmBeforeChange?: boolean;
  /** Run on the baseline after its checks; its stdout comes back with the run (JVM: bytecode references). */
  probe?: string[];
  notes: string[];
}

const SKIP =
  /(--watch|\bwatch\b|e2e|playwright|cypress|integration|deploy|publish|release|coverage-upload|storybook|lint|format|prettier|eslint|biome)/i;
const TYPECHECK_SCRIPTS = [
  "typecheck",
  "type-check",
  "check-types",
  "types",
  "tsc",
  "check:types",
  "typecheck:all",
];
const TEST_SCRIPTS = ["test", "test:unit", "unit", "test:ci"];
const PLACEHOLDER = /no test specified/;

const join = (dir: string, file: string) => (dir === "." ? file : `${dir}/${file}`);

function readJson<T>(tree: RepoTree, path: string): T | null {
  try {
    const text = tree.read(path);
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

function runScript(manager: JsManager, script: string, extra: string[] = []): string[] {
  switch (manager) {
    case "pnpm":
      return ["pnpm", "--config.verify-deps-before-run=false", "run", script, ...extra];
    case "yarn":
      return ["yarn", "run", script, ...extra];
    case "bun":
      return ["bun", "run", script, ...extra];
    default:
      return ["npm", "run", "-s", script, ...(extra.length ? ["--", ...extra] : [])];
  }
}

function exec(manager: JsManager, argv: string[]): string[] {
  switch (manager) {
    case "pnpm":
      return ["pnpm", "--config.verify-deps-before-run=false", "exec", ...argv];
    case "yarn":
      return ["yarn", "exec", ...argv];
    case "bun":
      return ["bunx", "--no-install", ...argv];
    default:
      return ["npx", "--no-install", ...argv];
  }
}

export function installCommand(manager: JsManager, lockfileVersion?: string): string[] {
  switch (manager) {
    case "pnpm":
      return [
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--config.verify-deps-before-run=false",
      ];
    case "yarn":
      // berry lockfiles carry `__metadata`; classic ones are version 1. Berry's `--mode=skip-build`
      // is its --ignore-scripts: no dependency build or lifecycle script runs.
      return lockfileVersion && lockfileVersion !== "1"
        ? ["yarn", "install", "--immutable", "--mode=skip-build"]
        : ["yarn", "install", "--frozen-lockfile", "--ignore-scripts", "--non-interactive"];
    case "bun":
      return ["bun", "install", "--frozen-lockfile", "--ignore-scripts"];
    default:
      return ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
  }
}

/** JSON report arguments when the script is one plain vitest or jest call. */
function reporterArgs(script: string, path: string): string[] | null {
  if (/[;&|]/.test(script)) return null;
  if (/^vitest(\s|$)/.test(script.trim()))
    return ["--reporter=default", "--reporter=json", `--outputFile.json=${path}`];
  if (/^jest(\s|$)/.test(script.trim())) return ["--json", `--outputFile=${path}`];
  return null;
}

/** `run:` lines of every workflow job, one command per line. */
function ciCommands(tree: RepoTree): string[] {
  const out: string[] = [];
  for (const file of tree.files()) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) continue;
    let doc: { jobs?: Record<string, { steps?: { run?: unknown }[] }> };
    try {
      doc = YAML.parse(tree.read(file) ?? "") ?? {};
    } catch {
      continue;
    }
    for (const job of Object.values(doc.jobs ?? {}))
      for (const step of job.steps ?? [])
        if (typeof step.run === "string")
          for (const line of step.run.split("\n")) if (line.trim()) out.push(line.trim());
  }
  return out;
}

export function detectJsChecks(tree: RepoTree, project: JsProject, sandboxRoot = "/work"): CheckPlan {
  const notes: string[] = [];
  const manifest = readJson<{
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  }>(tree, join(project.root, "package.json"));
  const scripts = manifest?.scripts ?? {};
  const deps = { ...manifest?.dependencies, ...manifest?.devDependencies };
  const manager = project.manager === "unknown" ? "npm" : project.manager;
  const cwd = project.root === "." ? sandboxRoot : `${sandboxRoot}/${project.root}`;
  const reportPath = "/tmp/teire-tests.json";
  const checks: PlannedCheck[] = [];
  const add = (check: PlannedCheck) => {
    if (!checks.some((c) => c.name === check.name)) checks.push(check);
  };
  const scriptCheck = (name: CheckName, script: string, source: PlannedCheck["source"]) => {
    const body = scripts[script] ?? "";
    if (name === "test") {
      const extra = reporterArgs(body, reportPath);
      add({ name, argv: runScript(manager, script, extra ?? []), source, ...(extra ? { reportPath } : {}) });
    } else add({ name, argv: runScript(manager, script), source });
  };

  // 1. CI: scripts the workflows run through the package manager.
  for (const line of ciCommands(tree)) {
    if (SKIP.test(line)) continue;
    const m = /^(?:npm|pnpm|yarn|bun)(?:\s+--?\S+)*\s+(?:run\s+)?([\w:.-]+)/.exec(line);
    const script = m?.[1];
    if (!script || !(script in scripts) || PLACEHOLDER.test(scripts[script] ?? "")) continue;
    if (TYPECHECK_SCRIPTS.includes(script) || /\btsc\b/.test(scripts[script] ?? ""))
      scriptCheck("typecheck", script, "ci");
    else if (/^build/.test(script)) scriptCheck("build", script, "ci");
    else if (/^test/.test(script) && !SKIP.test(scripts[script] ?? "")) scriptCheck("test", script, "ci");
  }

  // 2. Scripts by convention.
  const typecheck = TYPECHECK_SCRIPTS.find((s) => s in scripts);
  if (typecheck) scriptCheck("typecheck", typecheck, "script");
  const test = TEST_SCRIPTS.find(
    (s) => s in scripts && !PLACEHOLDER.test(scripts[s] ?? "") && !SKIP.test(scripts[s] ?? ""),
  );
  if (test) scriptCheck("test", test, "script");

  // 3. Defaults.
  if (
    !checks.some((c) => c.name === "typecheck") &&
    deps.typescript &&
    tree.read(join(project.root, "tsconfig.json")) !== null
  )
    add({
      name: "typecheck",
      argv: exec(manager, ["tsc", "--noEmit", "-p", "tsconfig.json"]),
      source: "default",
    });
  if (!checks.some((c) => c.name === "test")) {
    if (deps.vitest)
      add({
        name: "test",
        argv: exec(manager, ["vitest", "run", ...(reporterArgs("vitest", reportPath) ?? [])]),
        source: "default",
        reportPath,
      });
    else if (deps.jest)
      add({
        name: "test",
        argv: exec(manager, ["jest", "--ci", "--json", `--outputFile=${reportPath}`]),
        source: "default",
        reportPath,
      });
  }
  if (!checks.length) notes.push("no typecheck, build or test command found");

  const provenOffline = manager === "npm" || manager === "pnpm";
  if (!provenOffline)
    notes.push(`${manager} installs are not yet proven in the sandbox; evidence is labelled accordingly`);
  return {
    manager,
    image: "node",
    ...(project.managerVersion ? { managerVersion: project.managerVersion } : {}),
    cwd,
    install: installCommand(manager, project.lockfileVersion),
    env: manager === "pnpm" ? { npm_config_verify_deps_before_run: "false" } : {},
    checks,
    provenOffline,
    notes,
  };
}

/**
 * `verify` in teire.yml (C8): commands a repo names for a workspace replace the detected ones. They
 * run through `sh -c` in the same sandbox phases (install online, checks offline).
 */
export function withVerifyOverrides(
  plan: CheckPlan,
  workspace: string,
  overrides: { workspace: string; install?: string; typecheck?: string; test?: string }[] = [],
): CheckPlan {
  const o = overrides.find(
    (v) =>
      v.workspace.replace(/^\.\/|\/$/g, "") === workspace.replace(/^\.\/|\/$/g, "") ||
      (v.workspace === "." && workspace === "."),
  );
  if (!o) return plan;
  const sh = (cmd: string) => ["sh", "-c", cmd];
  const checks = [...plan.checks];
  for (const name of ["typecheck", "test"] as const) {
    const cmd = o[name];
    if (!cmd) continue;
    const at = checks.findIndex((c) => c.name === name);
    const check: PlannedCheck = { name, argv: sh(cmd), source: "script" };
    if (at >= 0) checks[at] = check;
    else checks.push(check);
  }
  return {
    ...plan,
    ...(o.install ? { install: sh(o.install) } : {}),
    checks,
    notes: [...plan.notes, `commands from teire.yml verify for ${o.workspace}`],
  };
}
