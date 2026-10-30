import { describe, expect, it } from "vitest";
import { readJvmInventory } from "../src/inventory/jvm";
import { memoryTree } from "../src/inventory/tree";
import { detectJvmChecks } from "../src/verify/jvm-commands";

describe("an Android project (S20.1)", () => {
  const tree = memoryTree({
    "settings.gradle.kts": 'rootProject.name = "demo"\ninclude(":app")\n',
    "gradle/libs.versions.toml":
      '[versions]\nagp = "8.7.3"\nokhttp = "3.14.9"\n[libraries]\nokhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }\n[plugins]\nandroid-application = { id = "com.android.application", version.ref = "agp" }\n',
    "build.gradle.kts": "plugins {\n  alias(libs.plugins.android.application) apply false\n}\n",
    "app/build.gradle.kts":
      'plugins {\n  alias(libs.plugins.android.application)\n}\nandroid { namespace = "dev.teire.demo"; compileSdk = 35 }\ndependencies {\n  implementation(libs.okhttp)\n}\n',
    gradlew: "#!/bin/sh\n",
  });
  const [project] = readJvmInventory(tree);

  it("is read as Android from the plugin its catalog names", () => {
    expect(project?.android).toBe(true);
    expect(project?.instances.find((i) => i.name === "com.squareup.okhttp3:okhttp")?.version).toBe("3.14.9");
  });

  it("builds in the Android image with the SDK and the debug unit tests", () => {
    if (!project) throw new Error("no project");
    const plan = detectJvmChecks(tree, project);
    expect(plan.image).toBe("android");
    expect(plan.env).toMatchObject({ ANDROID_HOME: "/opt/android-sdk" });
    expect(plan.installEnv).toMatchObject({ ANDROID_HOME: "/opt/android-sdk" });
    expect(plan.checks.map((c) => c.argv.at(-1))).toEqual(["teireTypecheck", "teireTest"]);
  });

  it("leaves a plain Gradle project in the JVM image", () => {
    const [jvm] = readJvmInventory(
      memoryTree({
        "settings.gradle": 'rootProject.name = "lib"\n',
        "build.gradle":
          "plugins { id 'java-library' }\ndependencies { implementation 'com.google.guava:guava:19.0' }\n",
      }),
    );
    if (!jvm) throw new Error("no project");
    expect(jvm.android).toBeUndefined();
    expect(detectJvmChecks(memoryTree({}), jvm).image).toBe("jvm");
  });
});
