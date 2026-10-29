import { describe, expect, it } from "vitest";
import { checkLines } from "../src/fix/run";
import { vendoredOutsideGraph } from "../src/resolver/events";
import type { CheckResult } from "../src/verify/evidence";

const file = (path: string, content: string | null = "x") => ({ path, content });
const moved = [
  { name: "github.com/pkg/errors", from: "v0.8.1", to: "v0.9.1", removed: false, directory: "/" },
];

describe("vendored files the change's own graph backs (R21, Codex)", () => {
  const modulesTxt = "# github.com/pkg/errors v0.9.1\n## explicit\ngithub.com/pkg/errors\n";
  const goSum = "github.com/pkg/errors v0.9.1 h1:abc=\ngithub.com/pkg/errors v0.9.1/go.mod h1:def=\n";

  it("keeps Go vendor files of a moved module listed at its new version in modules.txt and go.sum", () => {
    const files = [
      file("vendor/modules.txt", modulesTxt),
      file("go.sum", goSum),
      file("vendor/github.com/pkg/errors/errors.go"),
    ];
    expect(vendoredOutsideGraph("go", files, moved)).toEqual([]);
  });

  it("refuses vendor files a move event names but the graph doesn't back", () => {
    const forged = [
      file("vendor/modules.txt", modulesTxt),
      file("go.sum", goSum),
      file("vendor/github.com/evil/x/main.go"),
    ];
    expect(
      vendoredOutsideGraph("go", forged, [...moved, { ...moved[0], name: "github.com/evil/x" } as never]),
    ).toEqual(["vendor/github.com/evil/x/main.go"]);
    // No modules.txt in the change: nothing vendored is accounted for.
    expect(
      vendoredOutsideGraph(
        "go",
        [file("go.sum", goSum), file("vendor/github.com/pkg/errors/errors.go")],
        moved,
      ),
    ).toEqual(["vendor/github.com/pkg/errors/errors.go"]);
  });

  it("keeps a cached gem only at a moved gem's new version, locked in Gemfile.lock", () => {
    const gem = [{ name: "rack", from: "2.2.8", to: "3.1.8", removed: false, directory: "/" }];
    const lock = "GEM\n  specs:\n    rack (3.1.8)\n";
    expect(
      vendoredOutsideGraph(
        "rubygems",
        [file("Gemfile.lock", lock), file("vendor/cache/rack-3.1.8.gem")],
        gem,
      ),
    ).toEqual([]);
    expect(
      vendoredOutsideGraph(
        "rubygems",
        [file("Gemfile.lock", lock), file("vendor/cache/rack-9.9.9.gem")],
        gem,
      ),
    ).toEqual(["vendor/cache/rack-9.9.9.gem"]);
  });
});

describe("the checks as the bump review reads them (R21.3)", () => {
  const check = (name: CheckResult["name"], exitCode: number, passed?: number) =>
    ({
      name,
      exitCode,
      timedOut: false,
      counts: passed === undefined ? null : { collected: passed, passed, failed: 0, skipped: 0, errors: 0 },
    }) as CheckResult;

  it("says each check on both sides, with test counts", () => {
    expect(
      checkLines(
        [check("typecheck", 0), check("test", 0, 12)],
        [check("typecheck", 0), check("test", 0, 12)],
      ),
    ).toEqual([
      "typecheck: before exit 0; after exit 0",
      "test: before exit 0, 12 passed, 0 failed, 0 skipped; after exit 0, 12 passed, 0 failed, 0 skipped",
    ]);
    expect(checkLines([], [check("build", 1)])).toEqual(["build: before not run; after exit 1"]);
  });
});
