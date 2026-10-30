import { describe, expect, it } from "vitest";
import type { DependencyInstance } from "../src/contract";
import { memoryTree } from "../src/inventory/tree";
import { chooseTarget, withTargetMax } from "../src/registry/target";
import type { PackageInfo } from "../src/registry/types";
import { npmScheme } from "../src/registry/versions";
import { readDependabotConfig } from "../src/resolver/config";
import { dependabotVersioning } from "../src/resolver/scan-policy";

const YML = `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule: { interval: weekly }
    versioning-strategy: widen
    ignore:
      - dependency-name: "left-pad"
      - dependency-name: "@types/*"
        update-types: ["version-update:semver-major"]
      - dependency-name: "zod"
        versions: [">= 4.0.0-0"]
    cooldown:
      default-days: 30
      semver-patch-days: 0
    allow:
      - dependency-type: production
`;

const info = (name: string, versions: [string, string][], latest: string): PackageInfo => ({
  ecosystem: "npm",
  name,
  versions: versions.map(([version, publishedAt]) => ({
    version,
    publishedAt,
    deprecated: null,
    isDefault: version === latest,
  })),
  defaultVersion: latest,
  source: { name: "npm", url: "", contentHash: "x", checkedAt: "2026-10-30" },
});
const dep = (name: string, version: string, scope: DependencyInstance["scope"] = "prod") =>
  ({
    ecosystem: "npm",
    name,
    version,
    declaredRange: `^${version}`,
    direct: true,
    scope,
    workspace: ".",
    manifestPath: "package.json",
    source: "registry",
    resolvedBy: "lockfile",
  }) as DependencyInstance;
const base = {
  now: new Date("2026-10-30"),
  minAgeMinutes: () => 7 * 1440,
  pins: [],
  allowPrerelease: false,
  fallbackMajors: 0,
};
const project = { manager: "npm", root: "." };

describe("dependabot.yml at target choice (S18.6)", () => {
  const config = readDependabotConfig(memoryTree({ ".github/dependabot.yml": YML }));
  const scan = (explicit: string[] = []) => ({
    dependabot: { config, explicit },
    coverage: { notes: [] as string[] },
  });
  const choose = (pkg: PackageInfo, instance: DependencyInstance, options = scan()) =>
    chooseTarget(
      pkg,
      instance.version as string,
      withTargetMax(base, instance.name, options, "npm", { project, instance }),
      npmScheme,
    );

  it("holds an ignored package, a non-allowed type, and ignored majors and versions", () => {
    const pad = info(
      "left-pad",
      [
        ["1.0.0", "2026-01-01"],
        ["1.3.0", "2026-02-01"],
      ],
      "1.3.0",
    );
    expect(choose(pad, dep("left-pad", "1.0.0"))).toMatchObject({
      kind: "blocked",
      reason: "ignored in .github/dependabot.yml",
    });
    expect(choose(pad, dep("left-pad", "1.0.0", "dev"))).toMatchObject({ kind: "blocked" });
    const types = info(
      "@types/node",
      [
        ["20.1.0", "2026-01-01"],
        ["20.9.0", "2026-03-01"],
        ["22.0.0", "2026-04-01"],
      ],
      "22.0.0",
    );
    expect(choose(types, dep("@types/node", "20.1.0"))).toMatchObject({ kind: "upgrade", to: "20.9.0" });
    const zod = info(
      "zod",
      [
        ["3.22.0", "2026-01-01"],
        ["3.23.8", "2026-02-01"],
        ["4.1.0", "2026-03-01"],
      ],
      "4.1.0",
    );
    expect(choose(zod, dep("zod", "3.22.0"))).toMatchObject({ to: "3.23.8" });
  });

  it("applies its cooldown per update type, unless teire.yml sets one (said)", () => {
    const pkg = info(
      "ky",
      [
        ["1.0.0", "2026-01-01"],
        ["1.0.1", "2026-10-29"],
        ["1.2.0", "2026-10-15"],
      ],
      "1.2.0",
    );
    // The patch has no cooldown; the 15-day-old minor is under the 30-day default.
    expect(choose(pkg, dep("ky", "1.0.0"))).toMatchObject({ to: "1.0.1" });
    const options = scan(["upgrades.cooldownDays"]);
    expect(choose(pkg, dep("ky", "1.0.0"), options)).toMatchObject({ to: "1.2.0" });
    expect(options.coverage.notes[0]).toContain("teire.yml's upgrades.cooldownDays is used");
  });

  it("maps versioning-strategy, teire.yml winning", () => {
    expect(dependabotVersioning({ config, explicit: [] }, "npm", project)).toBe("widen");
    expect(dependabotVersioning({ config, explicit: ["upgrades.versioning"] }, "npm", project)).toBeNull();
  });
});
