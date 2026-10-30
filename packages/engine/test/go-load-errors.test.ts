import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assess } from "../src/impact";
import { locateGo } from "../src/locate/go";

const GO_MOD = "module example.com/app\n\ngo 1.22\n\nrequire github.com/google/uuid v1.6.0\n";
const GO_SUM =
  "github.com/google/uuid v1.6.0 h1:NIvaJDMOsjHA8n1jAhLSgzrAzy1Hgr+hNrb57e+94F0=\ngithub.com/google/uuid v1.6.0/go.mod h1:TIyPZe4MgqvfeYDBFedMoGGpEw/LqOeaOT+nhxU+yHo=\n";

describe("Go code that didn't type-check is never 'not affected' (S19)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const repo = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "teire-go-errors-"));
    dirs.push(dir);
    for (const [path, text] of Object.entries({ "go.mod": GO_MOD, "go.sum": GO_SUM, ...files })) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };
  const locate = (dir: string) =>
    locateGo({
      repoDir: dir,
      projectRoot: ".",
      modulePath: "github.com/google/uuid",
      declKeys: new Set(["NewString"]),
    });

  it("counts a selector the checker couldn't resolve, and a package that failed to load", async () => {
    const typeError = await locate(
      repo({
        "main.go":
          'package main\n\nimport "github.com/google/uuid"\n\nfunc main() { _ = uuid.NoSuchFunc() }\n',
      }),
    );
    expect(typeError.coverage.unresolvedSites).toBeGreaterThan(0);
    const syntaxError = await locate(
      repo({
        "main.go": 'package main\n\nimport "github.com/google/uuid"\n\nfunc main() { _ = uuid.NewString( }\n',
      }),
    );
    expect(syntaxError.coverage.unresolvedSites).toBeGreaterThan(0);
    expect(syntaxError.coverage.filesSkipped.some((s) => /did not type-check/.test(s.reason))).toBe(true);
    const clean = await locate(
      repo({
        "main.go":
          'package main\n\nimport "github.com/google/uuid"\n\nfunc main() { _ = uuid.NewString() }\n',
      }),
    );
    expect(clean.coverage.unresolvedSites).toBe(0);
    expect(clean.hits.map((h) => h.declKey)).toEqual(["NewString"]);
  }, 120_000);

  it("reads a load failure as inconclusive, not as unused", () => {
    const findings = assess({
      instance: {
        ecosystem: "go",
        name: "github.com/google/uuid",
        version: "v1.6.0",
        direct: true,
        scope: "prod",
        workspace: ".",
        manifestPath: "go.mod",
        source: "registry",
        resolvedBy: "toolchain",
      },
      target: "v2.0.0",
      isMajor: true,
      records: [],
      locate: null,
    });
    expect(findings.every((f) => f.verdict !== "not_affected")).toBe(true);
  });
});
