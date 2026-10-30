import { describe, expect, it } from "vitest";
import { gradleIncludes, gradleProjectDirs, readJvmInventory } from "../src/inventory/jvm";
import type { RepoTree } from "../src/inventory/tree";

const tree = (files: Record<string, string>): RepoTree => ({
  files: () => Object.keys(files),
  read: (p) => files[p] ?? null,
});

describe("Gradle builds read in full (D-26, D-27)", () => {
  it("reads includes over several lines and a project's own folder", () => {
    expect(
      gradleIncludes('include(\n  ":app",\n  ":lib" // the library\n)\ninclude ":tools",\n  ":docs"\n'),
    ).toEqual([":app", ":lib", ":tools", ":docs"]);
    expect(
      gradleProjectDirs(
        'project(":app").projectDir = file("apps/android")\nproject(\':lib\').projectDir = new File(settingsDir, "libs/core/")',
      ),
    ).toEqual(
      new Map([
        [":app", "apps/android"],
        [":lib", "libs/core"],
      ]),
    );
  });

  it("takes any configuration with a coordinate, and nothing else", () => {
    const [project] = readJvmInventory(
      tree({
        "settings.gradle.kts": 'include(\n  ":app"\n)\nproject(":app").projectDir = file("android/app")\n',
        "android/app/build.gradle.kts": `plugins { id("com.android.application") version "8.5.0" }
repositories { maven { url = uri("https://maven.example/x:y") } }
dependencies {
  implementation(platform("org.springframework.boot:spring-boot-dependencies:3.2.0"))
  debugImplementation("com.squareup.leakcanary:leakcanary-android:2.14")
  testFixturesApi("org.assertj:assertj-core:3.25.3")
  integrationTestImplementation("org.testcontainers:postgresql:1.19.7")
  androidTestImplementation("androidx.test:runner:1.5.2")
}
`,
      }),
    );
    const names = new Map(project?.instances.map((i) => [i.name, i]));
    expect(names.get("org.springframework.boot:spring-boot-dependencies")?.version).toBe("3.2.0");
    expect(names.get("com.squareup.leakcanary:leakcanary-android")?.scope).toBe("prod");
    expect(names.get("org.assertj:assertj-core")).toBeDefined();
    expect(names.get("org.testcontainers:postgresql")).toBeDefined();
    expect(names.get("androidx.test:runner")?.scope).toBe("test");
    expect([...names.keys()].some((n) => n.startsWith("https"))).toBe(false);
    expect(project?.instances[0]?.manifestPath.startsWith("android/app/")).toBe(true);
  });
});
