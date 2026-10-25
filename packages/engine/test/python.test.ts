import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bumpSpecifier, editRequirements, pyTransaction } from "../src/fix/upgrade-py";
import { assess, locateTargets, summariseFindings } from "../src/impact";
import { directoryTree, memoryTree } from "../src/inventory";
import { readPythonInventory } from "../src/inventory/python";
import { locatePython } from "../src/locate/python";
import { memoryCache, pypiScheme } from "../src/registry";
import { fetchPypiWheel, parameterName, pypiSurfaceDiff } from "../src/surface/pypi";
import { surfaceChangeRecords } from "../src/surface/records";
import { countsFromJunit, countsFromOutput } from "../src/verify";
import { detectPyChecks } from "../src/verify/python-commands";

// The helper runs through uv (packaging, griffe and jedi pinned in constants); CI installs uv.
const fixtures = resolve(import.meta.dirname, "../../../fixtures/python");
const options = { cache: memoryCache(), cacheDir: join(tmpdir(), "teire-test-packages") };

const instance = (name: string, declaredRange: string) => ({
  ecosystem: "pypi" as const,
  name,
  version: "0.125.0",
  declaredRange,
  direct: true,
  scope: "prod" as const,
  workspace: ".",
  manifestPath: "pyproject.toml",
  source: "registry" as const,
  resolvedBy: "lockfile" as const,
});

describe("python inventory", () => {
  it("reads a uv project: direct pins from the lock, dev groups, transitive scope by reachability", async () => {
    const [project] = await readPythonInventory(join(fixtures, "uvproj"));
    expect(project).toMatchObject({
      root: ".",
      manager: "uv",
      lockfile: "uv.lock",
      manifest: "pyproject.toml",
    });
    const byName = new Map(project?.instances.map((i) => [i.name, i]));
    expect(byName.get("anthropic")).toMatchObject({
      version: "0.125.0",
      direct: true,
      scope: "prod",
      declaredRange: "==0.125.0",
    });
    expect(byName.get("httpx")).toMatchObject({ version: "0.28.1", direct: true, declaredRange: ">=0.27" });
    expect(byName.get("pytest")).toMatchObject({ direct: true, scope: "dev" });
    // Pulled in only by pytest: dev. Pulled in by anthropic: prod.
    expect(byName.get("pluggy")).toMatchObject({ direct: false, scope: "dev" });
    expect(byName.get("pydantic")).toMatchObject({ direct: false, scope: "prod" });
    // The project itself is the repo's code, never a dependency.
    expect(byName.has("support-bot")).toBe(false);
  });

  it("reads requirements: -r recursion, hashes, markers, editable VCS, PEP 503 names", async () => {
    const [project] = await readPythonInventory(join(fixtures, "reqproj"));
    expect(project?.manager).toBe("pip");
    const byName = new Map(project?.instances.map((i) => [i.name, i]));
    expect(byName.get("numpy")).toMatchObject({ version: "2.1.0", manifestPath: "requirements.txt" });
    expect(byName.get("pydantic")).toMatchObject({ version: null, manifestPath: "requirements/base.txt" });
    expect(byName.get("pytest")).toMatchObject({ version: "9.1.1", manifestPath: "dev.txt" });
    expect(byName.get("pywin32")?.environment?.markers).toBe('sys_platform == "win32"');
    expect(byName.get("black")).toMatchObject({ source: "git", version: null });
    expect(byName.get("foo-bar-baz-qux")).toMatchObject({ version: "1.0" });
    // A constraint file narrows versions; it never declares a dependency.
    expect(byName.has("urllib3")).toBe(false);
  });
});

describe("python versions and specifiers", () => {
  it("orders PEP 440 versions and spots pre-releases", () => {
    expect(pypiScheme.compare("1.0.0rc1", "1.0.0")).toBeLessThan(0);
    expect(pypiScheme.compare("1.0.0.post1", "1.0.0")).toBeGreaterThan(0);
    expect(pypiScheme.isPrerelease("1.0.0b2")).toBe(true);
    expect(pypiScheme.isPrerelease("2026.10.23")).toBe(false);
  });

  it("bumps a specifier in its own style", () => {
    expect(bumpSpecifier("==0.125.0", "1.15.0")).toBe("==1.15.0");
    expect(bumpSpecifier("~=0.125", "1.15.0")).toBe("~=1.15.0");
    expect(bumpSpecifier(">=0.27", "1.0.0")).toBe(">=0.27");
    expect(bumpSpecifier(">=2,<3", "3.1.0")).toBe(">=3.1.0,<4");
    expect(bumpSpecifier("", "1.0.0")).toBe(">=1.0.0");
  });

  it("names the parameter in a griffe parameter line", () => {
    expect(parameterName("temperature: float | NotGiven = NOT_GIVEN")).toBe("temperature");
    expect(parameterName("**kwargs")).toBe("kwargs");
    expect(parameterName("*args: Any")).toBe("args");
    expect(parameterName(null)).toBeNull();
  });
});

describe("python upgrade transaction", () => {
  const pyproject = `[project]\nname = "app"\ndependencies = ["anthropic==0.125.0", "httpx>=0.27", "anthropic-tools==1.0"]\n`;
  const project = {
    root: ".",
    manager: "uv" as const,
    lockfile: "uv.lock",
    lockfileVersion: "1.3",
    manifest: "pyproject.toml",
    instances: [],
  };

  it("uv: edits the excluding pin, locks one package, and checks the lock holds the target", () => {
    const t = pyTransaction(
      memoryTree({ "pyproject.toml": pyproject }),
      project,
      instance("anthropic", "==0.125.0"),
      "1.15.0",
    );
    expect(t.manifest[0]?.after).toContain('"anthropic==1.15.0"');
    // A longer name sharing the prefix is left alone.
    expect(t.manifest[0]?.after).toContain('"anthropic-tools==1.0"');
    expect(t.commands).toEqual([["uv", "lock", "--upgrade-package", "anthropic"]]);
    expect(t.check?.({ "uv.lock": '[[package]]\nname = "anthropic"\nversion = "1.15.0"\n' })).toBeNull();
    expect(t.check?.({ "uv.lock": '[[package]]\nname = "anthropic"\nversion = "0.125.0"\n' })).toMatch(
      /still pins anthropic 0.125.0/,
    );
    // A newer allowed release than the target also satisfies the check (Poetry `update`).
    expect(t.check?.({ "uv.lock": '[[package]]\nname = "anthropic"\nversion = "1.16.0"\n' })).toBeNull();
  });

  it("uv: a range that already allows the target only relocks", () => {
    const t = pyTransaction(
      memoryTree({ "pyproject.toml": pyproject }),
      project,
      instance("httpx", ">=0.27"),
      "1.0.0",
    );
    expect(t.manifest).toEqual([]);
    expect(t.commands).toEqual([["uv", "lock", "--upgrade-package", "httpx==1.0.0"]]);
  });

  it("pip: replaces a hash-pinned line's hashes, and refuses without them", () => {
    const text =
      "-r base.txt\nnumpy==2.1.0 ; python_version >= '3.10' \\\n    --hash=sha256:aaaa \\\n    --hash=sha256:bbbb\nrich==13.0\n";
    const edit = editRequirements(text, "requirements.txt", "numpy", "2.2.0", ["cccc", "dddd"]);
    expect(edit?.after).toBe(
      "-r base.txt\nnumpy==2.2.0 ; python_version >= '3.10' \\\n    --hash=sha256:cccc \\\n    --hash=sha256:dddd\nrich==13.0\n",
    );
    expect(editRequirements(text, "requirements.txt", "numpy", "2.2.0")).toBeNull();
    expect(editRequirements("Foo_Bar==1.0\n", "r.txt", "foo-bar", "2.0")?.after).toBe("Foo_Bar==2.0\n");
  });
});

describe("python checks and reports", () => {
  it("plans a uv install online and pytest offline with a JUnit report", () => {
    const projectDir = join(fixtures, "uvproj");
    const plan = detectPyChecks(directoryTree(projectDir), {
      root: ".",
      manager: "uv",
      lockfile: "uv.lock",
      lockfileVersion: "1.3",
      manifest: "pyproject.toml",
      instances: [{ ...instance("pytest", ">=8"), version: "9.1.1", scope: "dev" }],
    });
    expect(plan).toMatchObject({
      image: "python",
      install: ["uv", "sync", "--frozen", "--all-groups"],
      provenOffline: true,
    });
    expect(plan.env.UV_OFFLINE).toBe("1");
    expect(plan.checks[0]).toMatchObject({ name: "test", reportFormat: "junit" });
    expect(plan.checks[0]?.argv.slice(0, 6)).toEqual(["uv", "run", "--frozen", "--offline", "python", "-m"]);
  });

  it("counts pytest results from JUnit XML and from the summary line", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="5" time="0.4"></testsuite></testsuites>`;
    expect(countsFromJunit(xml)).toEqual({ collected: 5, passed: 2, failed: 1, skipped: 1, errors: 1 });
    expect(countsFromJunit("<html></html>")).toBeNull();
    expect(countsFromOutput("==== 3 passed, 1 failed, 2 skipped in 0.52s ====")).toMatchObject({
      passed: 3,
      failed: 1,
      skipped: 2,
    });
  });
});

// Live: wheels come from PyPI (sha256-checked, cached across runs); griffe and jedi via the helper.
describe("python surface diff and call sites (live)", () => {
  it("anthropic 0.125.0 → 1.0.0: removals and removed keywords, only real call sites flagged", async () => {
    const diff = await pypiSurfaceDiff("anthropic", "0.125.0", "1.0.0", options);
    expect(diff).toMatchObject({
      ecosystem: "pypi",
      unanalyzable: false,
      tool: { name: "griffe", version: "2.4.1+teire2" },
    });
    expect(diff.counts).toMatchObject({ removed: 48, "parameter-removed": 54 });
    const paths = diff.changes.map((c) => `${c.kind} ${c.path}${c.param ? ` ${c.param}` : ""}`);
    expect(paths).toContain("removed anthropic._client.Anthropic.completions");
    expect(paths).toContain("removed anthropic.HUMAN_PROMPT");
    expect(paths).toContain(
      "parameter-removed anthropic.resources.messages.messages.Messages.create temperature",
    );

    const records = surfaceChangeRecords(diff);
    const repoDir = join(fixtures, "uvproj");
    const [project] = await readPythonInventory(repoDir);
    const wheel = await fetchPypiWheel("anthropic", "0.125.0", options);
    const located = await locatePython({
      repoDir,
      projectRoot: ".",
      packages: wheel.topLevel,
      siteDirs: [wheel.dir],
      ...locateTargets(records),
    });
    const instance = project?.instances.find((i) => i.name === "anthropic");
    if (!instance) throw new Error("anthropic missing from the fixture inventory");
    const summary = summariseFindings(
      assess({ instance, target: "1.0.0", isMajor: true, records, locate: located }),
    );
    expect(summary.verdict).toBe("affected");
    const sites = summary.breaking.flatMap((f) => f.callSites.map((s) => `${s.file}:${s.line}`));
    expect(sites).toEqual(expect.arrayContaining(["app/llm.py:1", "app/llm.py:7", "app/llm.py:13"]));
    // `messages.create(temperature=1)` on the repo's own Cache class resolves to the repo, not anthropic.
    expect(sites).not.toContain("app/llm.py:28");
  }, 180_000);
});

describe("python constructor keywords and local names (live)", () => {
  it("httpx 0.27 → 0.28: flags Client(proxies=…), not Client(proxy=…) or a parameter named like a removed function", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "teire-httpx-"));
    mkdirSync(join(repoDir, "app"));
    writeFileSync(join(repoDir, "app/__init__.py"), "");
    writeFileSync(
      join(repoDir, "app/net.py"),
      [
        "import httpx",
        "",
        "",
        "def old(url):",
        '    return httpx.Client(proxies={"all://": url})',
        "",
        "",
        "def new(url):",
        "    return httpx.Client(proxy=url)",
        "",
        "",
        "def handler(request: httpx.Request) -> httpx.Response:",
        "    return httpx.Response(200, json={'path': request.url.path})",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(repoDir, "app/wsgi.py"),
      "def app(environ, start):\n    return [environ.get('PATH_INFO', '').encode()]\n",
    );
    const records = surfaceChangeRecords(await pypiSurfaceDiff("httpx", "0.27.2", "0.28.1", options));
    const wheel = await fetchPypiWheel("httpx", "0.27.2", options);
    const located = await locatePython({
      repoDir,
      projectRoot: ".",
      packages: wheel.topLevel,
      siteDirs: [wheel.dir],
      ...locateTargets(records),
    });
    const summary = summariseFindings(
      assess({
        instance: { ...instance("httpx", "==0.27.2"), version: "0.27.2" },
        target: "0.28.1",
        isMajor: true,
        records,
        locate: located,
      }),
    );
    expect(summary.verdict).toBe("affected");
    expect(summary.breaking.flatMap((f) => f.callSites.map((s) => `${s.file}:${s.line}`))).toEqual([
      "app/net.py:5",
    ]);
    // `request` (a parameter) and `environ.get` (a file that never imports httpx) are not unknowns.
    expect(summary.coverage?.unresolvedSites).toBe(0);
  }, 180_000);
});
