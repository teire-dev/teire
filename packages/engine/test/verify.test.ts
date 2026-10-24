import { describe, expect, it } from "vitest";
import { bumpRange, lockfileCommand, planManifestEdits } from "../src/fix";
import type { JsProject } from "../src/inventory/js";
import { memoryTree } from "../src/inventory/tree";
import {
  type CheckResult,
  classifyFailure,
  countsFromOutput,
  decideEvidence,
  detectJsChecks,
  type SideResult,
} from "../src/verify";

const project = (manager: JsProject["manager"], extra: Partial<JsProject> = {}): JsProject => ({
  root: ".",
  manager,
  importers: ["."],
  instances: [],
  notes: [],
  ...extra,
});

describe("test counts from runner output", () => {
  it("reads vitest, jest, node:test and mocha summaries", () => {
    expect(
      countsFromOutput(" Test Files  1 passed (1)\n      Tests  2 passed | 1 failed (3)\n"),
    ).toMatchObject({
      collected: 3,
      passed: 2,
      failed: 1,
    });
    expect(countsFromOutput("Tests:       1 failed, 2 passed, 3 total\n")).toMatchObject({
      collected: 3,
      passed: 2,
      failed: 1,
    });
    expect(countsFromOutput("# tests 4\n# pass 4\n# fail 0\n# skipped 0\n")).toMatchObject({
      collected: 4,
      passed: 4,
    });
    expect(countsFromOutput("  5 passing (20ms)\n  1 pending\n")).toMatchObject({
      collected: 6,
      passed: 5,
      skipped: 1,
    });
    expect(countsFromOutput("nothing here")).toBeNull();
  });
});

const check = (
  name: CheckResult["name"],
  exitCode: number,
  extra: Partial<CheckResult> = {},
): CheckResult => ({
  name,
  argv: [],
  exitCode,
  ms: 1,
  timedOut: false,
  counts: null,
  typeErrors: 0,
  output: "",
  ...extra,
});
const side = (s: SideResult["side"], checks: CheckResult[], deniedHosts: string[] = []): SideResult => ({
  side: s,
  install: { ok: true, exitCode: 0, ms: 1, output: "" },
  checks,
  deniedHosts,
});
const tests = (collected: number, passed: number, failed = 0, skipped = 0) => ({
  collected,
  passed,
  failed,
  skipped,
  errors: 0,
});

describe("evidence", () => {
  it("is verified only when every check passes and the tests were counted", () => {
    const base = side("baseline", [check("typecheck", 0), check("test", 0, { counts: tests(3, 3) })]);
    expect(
      decideEvidence(base, side("after", [check("typecheck", 0), check("test", 0, { counts: tests(3, 3) })]))
        .kind,
    ).toBe("verified");
    expect(decideEvidence(base, side("after", [check("typecheck", 0), check("test", 0)])).kind).toBe(
      "typecheck_only",
    );
  });

  it("fails the test-count gate when tests disappear", () => {
    const base = side("baseline", [check("test", 0, { counts: tests(3, 3) })]);
    const after = side("after", [check("test", 0, { counts: tests(2, 2) })]);
    expect(decideEvidence(base, after)).toMatchObject({ kind: "regression", prMode: "issue" });
  });

  it("tells a pre-existing failure from one that needs the network", () => {
    const failing = (hosts: string[] = []) =>
      [
        side("baseline", [check("test", 1, { counts: tests(3, 2, 1) })], hosts),
        side("after", [check("test", 1, { counts: tests(3, 2, 1) })], hosts),
      ] as const;
    expect(decideEvidence(...failing()).kind).toBe("pre_existing_failure");
    expect(decideEvidence(...failing(["api.openai.com"]))).toMatchObject({
      kind: "needs_live_access",
      prMode: "draft",
    });
  });

  it("classifies refused local services and native-build mismatches", () => {
    expect(classifyFailure("Error: connect ECONNREFUSED 127.0.0.1:5432", []).cause).toBe(
      "needs_local_service",
    );
    expect(classifyFailure("was compiled against a different Node.js version", []).cause).toBe(
      "environment_mismatch",
    );
  });
});

describe("check commands", () => {
  it("prefers CI steps, adds a JSON report to plain vitest, and skips lint and e2e", () => {
    const tree = memoryTree({
      "package.json": JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          test: "vitest run",
          lint: "eslint .",
          "test:e2e": "playwright test",
        },
        devDependencies: { typescript: "5.9.3", vitest: "5.0.4" },
      }),
      ".github/workflows/ci.yml":
        "jobs:\n  check:\n    steps:\n      - run: pnpm install\n      - run: pnpm lint\n      - run: pnpm typecheck\n      - run: pnpm test:e2e\n",
    });
    const plan = detectJsChecks(tree, project("pnpm"));
    expect(plan.checks.map((c) => [c.name, c.source])).toEqual([
      ["typecheck", "ci"],
      ["test", "script"],
    ]);
    expect(plan.checks[1]?.argv).toContain("--reporter=json");
    expect(plan.install).toContain("--frozen-lockfile");
  });

  it("falls back to tsc and the test runner in devDependencies", () => {
    const tree = memoryTree({
      "package.json": JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
        devDependencies: { typescript: "6.0.3", jest: "30.0.0" },
      }),
      "tsconfig.json": "{}",
    });
    const plan = detectJsChecks(tree, project("npm"));
    expect(plan.checks.map((c) => `${c.name}:${c.source}:${c.argv.slice(0, 3).join(" ")}`)).toEqual([
      "typecheck:default:npx --no-install tsc",
      "test:default:npx --no-install jest",
    ]);
  });
});

describe("upgrade transaction (manifest)", () => {
  it("keeps the range style and the file's formatting", () => {
    expect(bumpRange("^4.104.0", "7.37.0")).toBe("^7.37.0");
    expect(bumpRange("~4.1.0", "7.37.0")).toBe("~7.37.0");
    expect(bumpRange("4.104.0", "7.37.0")).toBe("7.37.0");
    const manifest =
      '{\n    "name": "x",\n    "dependencies": { "openai": "^4.104.0", "zod": "^3.0.0" }\n}\n';
    const [edit] = planManifestEdits(
      memoryTree({ "package.json": manifest }),
      {
        ecosystem: "npm",
        name: "openai",
        version: "4.104.0",
        declaredRange: "^4.104.0",
        direct: true,
        scope: "prod",
        workspace: ".",
        manifestPath: "package.json",
        source: "registry",
        resolvedBy: "lockfile",
      },
      "7.37.0",
    );
    expect(edit?.after).toBe(manifest.replace("^4.104.0", "^7.37.0"));
    expect(lockfileCommand("npm")).toContain("--package-lock-only");
    expect(lockfileCommand("pnpm")).toContain("--lockfile-only");
  });
});
