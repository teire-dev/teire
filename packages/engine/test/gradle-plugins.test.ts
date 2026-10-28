import { describe, expect, it } from "vitest";
import { gradleEdits } from "../src/fix/upgrade-jvm";
import { readJvmInventory } from "../src/inventory/jvm";
import { memoryTree } from "../src/inventory/tree";

// The plugins block of teire-dev/spring-boot-realworld-example-app, and a Kotlin catalog alias.
const groovy = `plugins {
    id 'org.springframework.boot' version '2.6.3'
    id 'io.spring.dependency-management' version '1.0.11.RELEASE'
    id 'java'
    id "com.netflix.dgs.codegen" version "5.0.6"
}
dependencies { implementation 'io.jsonwebtoken:jjwt-api:0.11.2' }
`;

describe("Gradle plugins (S18.1)", () => {
  it("inventories versioned plugins by their marker coordinate, scope build", () => {
    const [project] = readJvmInventory(memoryTree({ "settings.gradle": "", "build.gradle": groovy }));
    const boot = project?.instances.find(
      (i) => i.name === "org.springframework.boot:org.springframework.boot.gradle.plugin",
    );
    expect(boot).toMatchObject({ version: "2.6.3", scope: "build", direct: true });
    expect(project?.instances.some((i) => i.name.startsWith("java:"))).toBe(false);
    expect(
      project?.instances.find(
        (i) => i.name === "com.netflix.dgs.codegen:com.netflix.dgs.codegen.gradle.plugin",
      )?.version,
    ).toBe("5.0.6");
  });

  it("reads catalog plugin aliases and edits either form", () => {
    const tree = memoryTree({
      "settings.gradle.kts": "",
      "build.gradle.kts": "plugins {\n  alias(libs.plugins.spring.boot)\n}\n",
      "gradle/libs.versions.toml":
        '[versions]\nboot = "3.3.0"\n\n[plugins]\nspring-boot = { id = "org.springframework.boot", version.ref = "boot" }\n',
    });
    const [project] = readJvmInventory(tree);
    const boot = project?.instances.find((i) => i.name.startsWith("org.springframework.boot:"));
    expect(boot?.version).toBe("3.3.0");
    const edits = gradleEdits(tree, project as never, boot as never, "4.0.1");
    expect(edits[0]?.after).toContain('boot = "4.0.1"');

    const plain = memoryTree({ "settings.gradle": "", "build.gradle": groovy });
    const [p2] = readJvmInventory(plain);
    const i2 = p2?.instances.find((i) => i.name.startsWith("org.springframework.boot:"));
    expect(gradleEdits(plain, p2 as never, i2 as never, "4.0.1")[0]?.after).toContain(
      "id 'org.springframework.boot' version '4.0.1'",
    );
  });
});

import { withJavaFloor } from "../src/fix/upgrade-jvm";

describe("Java co-upgrade (S15.10)", () => {
  it("raises every Java declaration below the floor, on top of the version edit", () => {
    const tree = memoryTree({
      "settings.gradle": "",
      "build.gradle": `${groovy}sourceCompatibility = '11'\ntargetCompatibility = '11'\n`,
    });
    const [project] = readJvmInventory(tree);
    const boot = project?.instances.find((i) => i.name.startsWith("org.springframework.boot:"));
    const versionEdits = gradleEdits(tree, project as never, boot as never, "4.0.1");
    const out = withJavaFloor(tree, project as never, versionEdits, 17, "Spring Boot 4.0.1 needs Java 17");
    expect(out).toHaveLength(1);
    expect(out[0]?.after).toContain("sourceCompatibility = '17'");
    expect(out[0]?.after).toContain("version '4.0.1'");
    expect(out[0]?.note).toContain("Java 17");
  });

  it("leaves a newer Java alone and reads Maven's properties", () => {
    const pom =
      "<project><properties><java.version>21</java.version><maven.compiler.release>11</maven.compiler.release></properties></project>";
    const tree = memoryTree({ "pom.xml": pom });
    const [project] = readJvmInventory(tree);
    const out = withJavaFloor(tree, project as never, [], 17, "x needs Java 17");
    expect(out[0]?.after).toContain("<java.version>21</java.version>");
    expect(out[0]?.after).toContain("<maven.compiler.release>17</maven.compiler.release>");
  });
});
