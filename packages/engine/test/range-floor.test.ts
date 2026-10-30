import { describe, expect, it } from "vitest";
import type { DependencyInstance } from "../src/contract";
import { beyondRange, chooseTarget, comparedInstance, rangeFloor } from "../src/registry/target";
import type { PackageInfo } from "../src/registry/types";
import { cargoScheme, npmScheme, pypiScheme, rubygemsScheme } from "../src/registry/versions";

const info = (ecosystem: PackageInfo["ecosystem"], versions: string[]): PackageInfo => ({
  ecosystem,
  name: "pkg",
  versions: versions.map((version) => ({
    version,
    publishedAt: "2025-01-01T00:00:00Z",
    deprecated: null,
    isDefault: version === versions.at(-1),
  })),
  defaultVersion: versions.at(-1) ?? null,
  source: { name: "deps.dev", url: "https://deps.dev", contentHash: "x", checkedAt: "2026-10-30" },
});

const policy = {
  now: new Date("2026-10-30"),
  minAgeMinutes: () => 0,
  pins: [],
  allowPrerelease: false,
  fallbackMajors: 0,
};

describe("a dependency no lockfile pins, compared from its range's floor (D-37)", () => {
  it("takes the lowest published, non-pre-release version the range allows", () => {
    const npm = info("npm", ["1.1.0", "1.2.0", "1.3.0-beta.1", "1.3.0", "2.0.0"]);
    expect(rangeFloor(npm, "^1.2.0", npmScheme)).toBe("1.2.0");
    expect(rangeFloor(npm, ">=1.2.1 <2", npmScheme)).toBe("1.3.0");
    expect(rangeFloor(npm, "latest", npmScheme)).toBeNull();
    expect(rangeFloor(info("pypi", ["1.0", "2.0", "2.5", "3.0"]), ">=2,<3", pypiScheme)).toBe("2.0");
    // Cargo's bare requirement is a caret range.
    expect(rangeFloor(info("cargo", ["0.7.3", "0.8.0", "0.8.5", "0.9.0"]), "0.8", cargoScheme)).toBe("0.8.0");
    expect(rangeFloor(info("rubygems", ["6.1.0", "7.0.4", "7.1.2", "8.0.0"]), "~> 7.0", rubygemsScheme)).toBe(
      "7.0.4",
    );
  });

  it("proposes nothing a fresh install already gets, and moves the range for a major past it", () => {
    const npm = info("npm", ["1.2.0", "1.4.0"]);
    expect(beyondRange(chooseTarget(npm, "1.2.0", policy, npmScheme), "^1.2.0", npmScheme)).toMatchObject({
      kind: "up-to-date",
      from: "1.2.0",
    });
    const major = info("npm", ["1.2.0", "1.4.0", "2.1.0"]);
    expect(beyondRange(chooseTarget(major, "1.2.0", policy, npmScheme), "^1.2.0", npmScheme)).toMatchObject({
      kind: "upgrade",
      from: "1.2.0",
      to: "2.1.0",
      isMajor: true,
    });
  });

  it("marks the compared version as the floor, and keeps a locked one as it is", () => {
    const declared = {
      ecosystem: "npm",
      name: "pkg",
      version: null,
      declaredRange: "^1.2.0",
      direct: true,
      scope: "prod",
      workspace: ".",
      manifestPath: "package.json",
      source: "registry",
      resolvedBy: "unresolved",
    } as DependencyInstance;
    const npm = info("npm", ["1.2.0", "2.0.0"]);
    expect(comparedInstance(declared, npm, npmScheme)).toMatchObject({
      version: "1.2.0",
      resolvedBy: "range-floor",
    });
    const locked = { ...declared, version: "1.4.0", resolvedBy: "lockfile" } as DependencyInstance;
    expect(comparedInstance(locked, npm, npmScheme)).toBe(locked);
    expect(comparedInstance({ ...declared, declaredRange: "workspace:*" }, npm, npmScheme)).toBeNull();
  });
});
