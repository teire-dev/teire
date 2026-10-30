import { describe, expect, it } from "vitest";
import { planManifestEdits } from "../src/fix/upgrade-js";
import { widenSpecifier } from "../src/fix/upgrade-py";
import { widenGemRequirement } from "../src/fix/upgrade-ruby";
import { uvExcludeNewer } from "../src/inventory/python";
import { memoryTree } from "../src/inventory/tree";
import { npmDistTag } from "../src/registry/clients";
import { chooseTarget, withTargetMax } from "../src/registry/target";
import type { PackageInfo } from "../src/registry/types";
import { npmScheme } from "../src/registry/versions";

const info = (versions: [string, string][], latest: string): PackageInfo => ({
  ecosystem: "npm",
  name: "pkg",
  versions: versions.map(([version, publishedAt]) => ({
    version,
    publishedAt,
    deprecated: null,
    isDefault: version === latest,
  })),
  defaultVersion: latest,
  source: { name: "npm", url: "https://registry.npmjs.org/pkg", contentHash: "x", checkedAt: "2026-10-30" },
});
const base = {
  now: new Date("2026-10-30"),
  minAgeMinutes: () => 0,
  pins: [],
  allowPrerelease: false,
  fallbackMajors: 0,
};
const pkg = info(
  [
    ["4.0.0", "2026-01-01"],
    ["4.1.0", "2026-06-01"],
    ["5.0.0-rc.1", "2026-09-01"],
    ["5.0.0", "2026-10-20"],
  ],
  "4.1.0",
);

describe("target policy keys (D-43, S18.5)", () => {
  it("stays under latest by default, opts into pre-releases, and follows a dist-tag", () => {
    expect(chooseTarget(pkg, "4.0.0", base, npmScheme)).toMatchObject({ to: "4.1.0" });
    expect(
      chooseTarget(pkg, "4.0.0", withTargetMax(base, "pkg", { prereleases: ["npm:pkg"] }, "npm"), npmScheme),
    ).toMatchObject({
      to: "5.0.0",
    });
    expect(
      chooseTarget(pkg, "4.0.0", { ...base, followTag: { tag: "next", version: "5.0.0-rc.1" } }, npmScheme),
    ).toMatchObject({
      to: "5.0.0-rc.1",
    });
  });

  it("refuses what uv's exclude-newer would", () => {
    const ceiling = { date: "2026-07-01T00:00:00.000Z", source: "uv exclude-newer in pyproject.toml" };
    expect(chooseTarget(pkg, "4.0.0", { ...base, publishedBefore: ceiling }, npmScheme)).toMatchObject({
      to: "4.1.0",
    });
    expect(
      uvExcludeNewer(
        memoryTree({ "pyproject.toml": '[tool.uv]\nexclude-newer = "2026-07-01T00:00:00Z"\n' }),
        ".",
      ),
    ).toEqual({ date: "2026-07-01T00:00:00.000Z", source: "uv exclude-newer in pyproject.toml" });
    expect(
      uvExcludeNewer(
        memoryTree({ "uv.toml": 'exclude-newer = "1 week"\n' }),
        ".",
        new Date("2026-10-30T00:00:00Z"),
      )?.date,
    ).toBe("2026-10-23T00:00:00.000Z");
  });

  it("reads a dist-tag from npm (live)", async () => {
    expect(await npmDistTag("react", "latest")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(await npmDistTag("react", "no-such-tag-teire")).toBeNull();
  }, 30_000);
});

describe("libraries widen ranges, apps bump (S18.5)", () => {
  it("widens a library's runtime range and bumps its dev one", () => {
    const text = JSON.stringify({
      name: "lib",
      dependencies: { zod: "^3.22.0" },
      devDependencies: { vitest: "^1.0.0" },
    });
    const tree = memoryTree({ "package.json": text });
    const zod = {
      ecosystem: "npm",
      name: "zod",
      version: "3.23.8",
      declaredRange: "^3.22.0",
      direct: true,
      scope: "prod",
      workspace: ".",
      manifestPath: "package.json",
      source: "registry",
      resolvedBy: "lockfile",
    } as const;
    expect(planManifestEdits(tree, zod, "4.1.0", true)[0]).toMatchObject({
      to: "^3.22.0 || ^4.1.0",
      note: "library range widened",
    });
    expect(planManifestEdits(tree, zod, "4.1.0", false)[0]?.to).toBe("^4.1.0");
  });

  it("widens PEP 440 and RubyGems requirements, keeping the floor", () => {
    expect(widenSpecifier(">=1.2,<2", "2.3.0")).toBe(">=1.2,<3");
    expect(widenSpecifier("~=1.4", "2.0.1")).toBe(">=1.4,<3");
    expect(widenSpecifier(">=1.2,!=1.5.0,<2", "2.0")).toBe(">=1.2,!=1.5.0,<3");
    expect(widenSpecifier(">=1.2", "2.0")).toBe(">=1.2");
    expect(widenGemRequirement(["~> 2.2"], "3.1.0")).toEqual([">= 2.2", "< 4"]);
    expect(widenGemRequirement([">= 2.2", "< 3"], "3.1.0")).toEqual([">= 2.2", "< 4"]);
    expect(widenGemRequirement([">= 2.2"], "3.1.0")).toBeNull();
  });
});
