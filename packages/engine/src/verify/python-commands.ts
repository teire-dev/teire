import { parse as parseToml } from "smol-toml";
import YAML from "yaml";
import type { PyProject } from "../inventory/python";
import type { RepoTree } from "../inventory/tree";
import type { CheckPlan, PlannedCheck } from "./commands";
import { pythonEnv, pythonFor } from "./toolchains";

/**
 * What to run for a Python project (research python.md §9): the repo's CI steps first (pytest,
 * mypy, pyright), re-run through the repo's own runner with the network off; then defaults
 * (`python -m pytest` when tests exist, mypy when it is configured). Installs happen online with
 * the repo's own tool; checks run offline (`UV_OFFLINE=1`, no index). `python -m pytest` keeps the
 * project root importable, which plain `pytest` under uv did not (research).
 */
const JUNIT = "/tmp/teire-junit.xml";
const SKIP =
  /(--watch|e2e|integration|deploy|publish|release|lint|ruff|black|flake8|format|isort|pre-commit|coverage\s+(report|xml|html)|build\b)/i;

const join = (dir: string, file: string) => (dir === "." ? file : `${dir}/${file}`);

function runner(project: PyProject): string[] {
  switch (project.manager) {
    case "uv":
      return ["uv", "run", "--frozen", "--offline"];
    case "poetry":
      return ["poetry", "run"];
    case "pipenv":
      return ["pipenv", "run"];
    default:
      return [".venv/bin/python", "-m"];
  }
}

/** `python -m <tool> args` through the project's runner. */
function module(project: PyProject, tool: string, args: string[]): string[] {
  const r = runner(project);
  return r[0] === ".venv/bin/python" ? [...r, tool, ...args] : [...r, "python", "-m", tool, ...args];
}

function installCommand(project: PyProject, tree: RepoTree): string[] {
  switch (project.manager) {
    case "uv":
      return ["uv", "sync", "--frozen", "--all-groups"];
    case "poetry":
      return ["poetry", "install", "--no-root", "--no-interaction"];
    case "pipenv":
      return ["pipenv", "sync", "--dev"];
    default: {
      const root = project.root;
      const files = tree
        .files()
        .filter((f) =>
          root === "."
            ? !f.includes("/")
            : f.startsWith(`${root}/`) && !f.slice(root.length + 1).includes("/"),
        )
        .map((f) => f.slice(root === "." ? 0 : root.length + 1))
        .filter((f) => /^requirements.*\.txt$/.test(f));
      const reqs = project.lockfile
        ? [
            project.lockfile.slice(root === "." ? 0 : root.length + 1),
            ...files.filter((f) => /dev|test/.test(f)),
          ]
        : files;
      const install = [...new Set(reqs)].map((f) => `-r ${f}`).join(" ");
      return [
        "sh",
        "-c",
        `uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python ${install}`.trim(),
      ];
    }
  }
}

/** pytest/mypy/pyright invocations in the repo's workflows, as tool + arguments. */
function ciTools(tree: RepoTree): { tool: "pytest" | "mypy" | "pyright"; args: string[] }[] {
  const found: { tool: "pytest" | "mypy" | "pyright"; args: string[] }[] = [];
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
          for (const raw of step.run.split("\n")) {
            const line = raw
              .trim()
              .replace(/^(uv run( --[\w-]+)*|poetry run|pipenv run|python -m|python3 -m)\s+/, "");
            const m = /^(pytest|mypy|pyright|basedpyright)\b(.*)$/.exec(line);
            if (!m?.[1] || SKIP.test(line)) continue;
            const tool = m[1] === "basedpyright" ? "pyright" : (m[1] as "pytest" | "mypy" | "pyright");
            const args = (m[2] ?? "")
              .trim()
              .split(/\s+/)
              .filter((a) => a && !a.startsWith("--junitxml") && !/^\$/.test(a));
            if (!found.some((f) => f.tool === tool)) found.push({ tool, args });
          }
  }
  return found;
}

export function detectPyChecks(tree: RepoTree, project: PyProject, sandboxRoot = "/work"): CheckPlan {
  const notes: string[] = [];
  const names = new Set(project.instances.map((i) => i.name));
  const manifest = project.manifest?.endsWith("pyproject.toml") ? tree.read(project.manifest) : null;
  let pyproject: Record<string, unknown> = {};
  try {
    pyproject = manifest ? (parseToml(manifest) as Record<string, unknown>) : {};
  } catch {
    notes.push("pyproject.toml did not parse");
  }
  const tool = (pyproject.tool ?? {}) as Record<string, unknown>;
  const exists = (path: string) => tree.read(join(project.root, path)) !== null;
  const hasTests = tree
    .files()
    .some((f) =>
      new RegExp(
        `^${project.root === "." ? "" : `${project.root}/`}(tests?/|test_[^/]+\\.py$|[^/]+_test\\.py$)`,
      ).test(f),
    );
  const checks: PlannedCheck[] = [];
  const pytestArgs = ["-q", "-p", "no:cacheprovider", `--junitxml=${JUNIT}`];

  for (const ci of ciTools(tree)) {
    if (ci.tool === "pytest")
      checks.push({
        name: "test",
        argv: module(project, "pytest", [...ci.args, ...pytestArgs]),
        source: "ci",
        reportPath: JUNIT,
        reportFormat: "junit",
      });
    else if (!checks.some((c) => c.name === "typecheck"))
      checks.push({ name: "typecheck", argv: module(project, ci.tool, ci.args), source: "ci" });
  }
  if (!checks.some((c) => c.name === "typecheck")) {
    if (names.has("mypy") && (tool.mypy || exists("mypy.ini") || exists(".mypy.ini")))
      checks.push({
        name: "typecheck",
        argv: module(project, "mypy", tool.mypy && (tool.mypy as { files?: unknown }).files ? [] : ["."]),
        source: "default",
      });
    else if (
      (names.has("pyright") || names.has("basedpyright")) &&
      (tool.pyright || tool.basedpyright || exists("pyrightconfig.json"))
    )
      checks.push({
        name: "typecheck",
        argv: module(project, names.has("basedpyright") ? "basedpyright" : "pyright", []),
        source: "default",
      });
  }
  if (!checks.some((c) => c.name === "test") && (names.has("pytest") || hasTests))
    checks.push({
      name: "test",
      argv: module(project, "pytest", pytestArgs),
      source: "default",
      reportPath: JUNIT,
      reportFormat: "junit",
    });
  if (!checks.length) notes.push("no pytest, mypy or pyright to run");
  const provenOffline = project.manager === "uv";
  if (!provenOffline)
    notes.push(
      `${project.manager} installs are not yet proven in the sandbox; evidence is labelled accordingly`,
    );
  // The Python the repo asks for (.python-version, requires-python), from the versions in the image.
  const python = pythonFor(tree, project.root);
  if (python?.note) notes.push(python.note);
  const pyPath = pythonEnv(python);
  return {
    manager: project.manager,
    image: "python",
    cwd: project.root === "." ? sandboxRoot : `${sandboxRoot}/${project.root}`,
    install: installCommand(project, tree),
    installEnv: {
      PIPENV_VENV_IN_PROJECT: "1",
      POETRY_VIRTUALENVS_IN_PROJECT: "true",
      UV_PYTHON_DOWNLOADS: "never",
      ...pyPath,
    },
    env: {
      UV_OFFLINE: "1",
      UV_PYTHON_DOWNLOADS: "never",
      PIP_NO_INDEX: "1",
      PIPENV_VENV_IN_PROJECT: "1",
      POETRY_VIRTUALENVS_IN_PROJECT: "true",
      PYTHONDONTWRITEBYTECODE: "1",
      ...pyPath,
    },
    checks,
    provenOffline,
    notes,
  };
}
