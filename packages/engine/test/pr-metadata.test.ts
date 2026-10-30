import { describe, expect, it } from "vitest";
import { inferredCommitPrefix, updatedDependenciesTrailer } from "../src/github/compose";

describe("Dependabot-shaped commit metadata (S20.2)", () => {
  it("writes the updated-dependencies trailer merge bots parse", () => {
    const trailer = updatedDependenciesTrailer(
      { ecosystem: "npm", name: "zod", version: "3.23.8", direct: true, scope: "prod" },
      "4.1.0",
      [
        { name: "zod", from: "3.23.8", to: "4.1.0" },
        { name: "@zod/core", from: "0.1.0", to: "0.1.2" },
        { name: "left-pad", from: "1.0.0", to: null, removed: true },
      ],
    );
    expect(trailer).toBe(
      [
        "---",
        "updated-dependencies:",
        "- dependency-name: zod",
        "  dependency-version: 4.1.0",
        "  dependency-type: direct:production",
        "  update-type: version-update:semver-major",
        "- dependency-name: @zod/core",
        "  dependency-version: 0.1.2",
        "  dependency-type: indirect",
        "  update-type: version-update:semver-patch",
        "...",
      ].join("\n"),
    );
    expect(
      updatedDependenciesTrailer(
        { ecosystem: "pypi", name: "pytest", version: "8.1.0", direct: true, scope: "dev" },
        "8.3.0",
      ),
    ).toContain("dependency-type: direct:development\n  update-type: version-update:semver-minor");
  });

  it("follows the repository's own commit style", () => {
    const conventional = [
      "feat: add x",
      "fix(api): y",
      "build(deps): bump a",
      "docs: z",
      "chore: w",
      "Merge pull request #3",
    ];
    expect(inferredCommitPrefix(conventional, false)).toBe("build(deps): ");
    expect(inferredCommitPrefix(conventional, true)).toBe("build(deps-dev): ");
    expect(inferredCommitPrefix(["feat: a", "fix: b", "docs: c", "chore: d", "test: e"], false)).toBe(
      "chore(deps): ",
    );
    expect(inferredCommitPrefix(["Add a", "Fix b", "Update c", "Bump d", "Refactor e"], false)).toBe("");
  });
});
