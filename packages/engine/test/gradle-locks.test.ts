import { describe, expect, it } from "vitest";
import { type Transaction, withGradleLocks } from "../src/fix";
import type { JvmProject } from "../src/inventory/jvm";

const project = {
  manager: "gradle",
  root: "kotlin-major",
  modules: [
    {
      name: ".",
      dir: "kotlin-major",
      manifest: "kotlin-major/build.gradle.kts",
      lockfile: "kotlin-major/gradle.lockfile",
    },
  ],
} as unknown as JvmProject;

const fromResolver: Transaction = {
  describe: "dependabot-core's updater: okhttp 3.14.9 → 5.5.0",
  manifest: [
    {
      path: "kotlin-major/gradle/libs.versions.toml",
      before: 'okhttp = "3.14.9"',
      after: 'okhttp = "5.5.0"',
      from: "3.14.9",
      to: "5.5.0",
    },
    {
      path: "kotlin-major/gradle.lockfile",
      before: "every entry",
      after: "every entry rewritten",
      from: "",
      to: "",
    },
  ],
  commands: [],
  readBack: ["kotlin-major/gradle/libs.versions.toml", "kotlin-major/gradle.lockfile"],
};

describe("Gradle locks after the resolver (D104)", () => {
  const tx = withGradleLocks(fromResolver, project, "com.squareup.okhttp3:okhttp", "5.5.0");

  it("keeps the updater's manifest edit and drops its rewritten lockfile", () => {
    expect(tx.manifest.map((m) => m.path)).toEqual(["kotlin-major/gradle/libs.versions.toml"]);
  });

  it("re-locks only the coordinate, in the project's own directory", () => {
    expect(tx.commands).toEqual([
      ["env", "-C", "/work/kotlin-major", "teire-jvm", "lock-gradle", "com.squareup.okhttp3:okhttp", "."],
    ]);
  });

  it("fails the readback when the lock does not hold the target", () => {
    expect(
      tx.check?.({ "kotlin-major/gradle.lockfile": "com.squareup.okhttp3:okhttp:3.14.9=runtimeClasspath" }),
    ).toContain("does not lock");
    expect(
      tx.check?.({ "kotlin-major/gradle.lockfile": "com.squareup.okhttp3:okhttp:5.5.0=runtimeClasspath" }),
    ).toBeNull();
  });
});
