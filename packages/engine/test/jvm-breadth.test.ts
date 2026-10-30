import { describe, expect, it } from "vitest";
import { wrapperTransaction } from "../src/fix/gradle-wrapper";
import { gradleEdits, mavenEdit, mavenPropertyOverride } from "../src/fix/upgrade-jvm";
import { gradleVariables, readJvmInventory } from "../src/inventory/jvm";
import { memoryTree } from "../src/inventory/tree";
import { remoteManaged } from "../src/registry/maven-pom";
import { memoryCache } from "../src/registry/types";

const POM = `<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>
  </parent>
  <artifactId>app</artifactId>
  <properties><java.version>17</java.version></properties>
  <dependencyManagement><dependencies>
    <dependency><groupId>software.amazon.awssdk</groupId><artifactId>bom</artifactId><version>2.25.0</version><type>pom</type><scope>import</scope></dependency>
  </dependencies></dependencyManagement>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>\${jackson.version}</version></dependency>
  </dependencies>
  <build><plugins>
    <plugin>
      <artifactId>maven-surefire-plugin</artifactId>
      <version>3.1.2</version>
      <dependencies><dependency><groupId>org.junit</groupId><artifactId>junit-bom</artifactId><version>5.10.0</version></dependency></dependencies>
    </plugin>
    <plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin>
  </plugins></build>
  <profiles><profile><id>it</id><dependencies>
    <dependency><groupId>org.testcontainers</groupId><artifactId>postgresql</artifactId><version>1.19.3</version><scope>test</scope></dependency>
  </dependencies></profile></profiles>
</project>`;

const maven = () =>
  memoryTree({
    "pom.xml": POM,
    ".mvn/extensions.xml":
      "<extensions><extension><groupId>kr.motd.maven</groupId><artifactId>os-maven-plugin</artifactId><version>1.7.1</version></extension></extensions>",
    ".mvn/wrapper/maven-wrapper.properties":
      "distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.5/apache-maven-3.9.5-bin.zip\n",
  });

describe("Maven candidates beyond dependencies (S18.3)", () => {
  const [project] = readJvmInventory(maven());
  const of = (name: string) => project?.instances.find((i) => i.name === name);

  it("reads the parent, BOM imports, plugins, extensions, profiles and the wrapper", () => {
    expect(of("org.springframework.boot:spring-boot-starter-parent")).toMatchObject({
      role: "parent",
      version: "3.2.0",
    });
    expect(of("software.amazon.awssdk:bom")).toMatchObject({ role: "bom", version: "2.25.0" });
    // Maven's default group; the plugin's own junit dependency is not the plugin.
    expect(of("org.apache.maven.plugins:maven-surefire-plugin")).toMatchObject({
      role: "plugin",
      version: "3.1.2",
    });
    expect(of("org.junit:junit-bom")).toBeUndefined();
    expect(of("org.springframework.boot:spring-boot-maven-plugin")).toMatchObject({
      version: null,
      role: "plugin",
    });
    expect(of("kr.motd.maven:os-maven-plugin")).toMatchObject({
      role: "extension",
      manifestPath: ".mvn/extensions.xml",
    });
    expect(of("org.testcontainers:postgresql")).toMatchObject({ scope: "test", version: "1.19.3" });
    expect(of("org.apache.maven:apache-maven")).toMatchObject({ role: "wrapper", version: "3.9.5" });
    expect(project?.modules[0]?.remote).toMatchObject({
      parent: "org.springframework.boot:spring-boot-starter-parent:3.2.0",
      imports: ["software.amazon.awssdk:bom:2.25.0"],
    });
  });

  it("edits the parent's and a plugin's version, never a nested one", () => {
    const tree = maven();
    const parent = of("org.springframework.boot:spring-boot-starter-parent");
    const surefire = of("org.apache.maven.plugins:maven-surefire-plugin");
    if (!project || !parent || !surefire) throw new Error("inventory");
    expect(mavenEdit(tree, project, parent, "3.3.5")?.after).toContain(
      "<artifactId>spring-boot-starter-parent</artifactId>\n    <version>3.3.5</version>",
    );
    const after = mavenEdit(tree, project, surefire, "3.5.2")?.after ?? "";
    expect(after).toContain("<version>3.5.2</version>");
    expect(after).toContain("<artifactId>junit-bom</artifactId><version>5.10.0</version>");
    expect(mavenPropertyOverride(tree, "pom.xml", "jackson.version", "2.17.2")?.after).toContain(
      "<java.version>17</java.version>",
    );
    expect(mavenPropertyOverride(tree, "pom.xml", "jackson.version", "2.17.2")?.after).toMatch(
      /<jackson\.version>2\.17\.2<\/jackson\.version>\n\s*<\/properties>|<properties><java\.version>/,
    );
  });

  it("resolves versions a remote parent and its BOMs manage (live, D-28)", async () => {
    const mod = project?.modules[0];
    if (!mod?.remote) throw new Error("no remote");
    const remote = await remoteManaged(mod.remote, { cache: memoryCache() });
    expect(remote.dependencies.get("org.springframework.boot:spring-boot-starter-web")).toMatchObject({
      version: "3.2.0",
      by: "org.springframework.boot:spring-boot-starter-parent 3.2.0",
    });
    // Spring Boot 3.2.0 imports jackson-bom 2.15.3.
    expect(remote.dependencies.get("com.fasterxml.jackson.core:jackson-databind")?.version).toBe("2.15.3");
    expect(remote.props["jackson.version"]).toBeUndefined();
    expect(remote.props["jackson-bom.version"]).toBe("2.15.3");
    expect(remote.plugins.get("org.springframework.boot:spring-boot-maven-plugin")?.version).toBe("3.2.0");
  }, 120_000);
});

describe("Gradle candidates beyond strings and the catalog (S18.3)", () => {
  const tree = memoryTree({
    "settings.gradle.kts": 'rootProject.name = "x"\ninclude(":app")\nincludeBuild("tools/plugin")\n',
    "gradle.properties": "okhttpVersion=4.11.0\n",
    "build.gradle.kts":
      'val kotlinVersion = "1.9.22"\nplugins { id("com.diffplug.spotless") version "6.25.0" }\n',
    "app/build.gradle.kts": `dependencies {
  implementation(platform("org.springframework.boot:spring-boot-dependencies:3.2.0"))
  implementation("org.jetbrains.kotlin:kotlin-stdlib:$kotlinVersion")
  implementation("com.squareup.okhttp3:okhttp:\${okhttpVersion}")
  implementation(group = "com.google.guava", name = "guava", version = "32.1.3-jre")
  debugImplementation("com.squareup.leakcanary:leakcanary-android:2.12")
}`,
    "buildSrc/build.gradle.kts": 'dependencies { implementation("com.android.tools.build:gradle:8.2.0") }\n',
    "buildSrc/src/main/kotlin/conventions.gradle.kts":
      'dependencies { testImplementation("org.junit.jupiter:junit-jupiter:5.10.1") }\n',
    "tools/plugin/build.gradle.kts": 'dependencies { implementation("org.ow2.asm:asm:9.6") }\n',
    "gradle/wrapper/gradle-wrapper.properties":
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-bin.zip\n",
  });
  const projects = readJvmInventory(tree);
  const main = projects.find((p) => p.root === ".");
  const of = (name: string) => projects.flatMap((p) => p.instances).find((i) => i.name === name);

  it("reads variables, map notation, platform BOMs, buildSrc, an included build and the wrapper", () => {
    expect(of("org.jetbrains.kotlin:kotlin-stdlib")).toMatchObject({
      version: "1.9.22",
      declaredRange: "$kotlinVersion",
    });
    expect(of("com.squareup.okhttp3:okhttp")?.version).toBe("4.11.0");
    expect(of("com.google.guava:guava")?.version).toBe("32.1.3-jre");
    expect(of("org.springframework.boot:spring-boot-dependencies")).toMatchObject({
      role: "bom",
      version: "3.2.0",
    });
    expect(of("com.diffplug.spotless:com.diffplug.spotless.gradle.plugin")).toMatchObject({ role: "plugin" });
    expect(of("com.android.tools.build:gradle")).toMatchObject({ workspace: ":buildSrc", version: "8.2.0" });
    expect(of("org.junit.jupiter:junit-jupiter")?.scope).toBe("test");
    expect(projects.some((p) => p.root === "tools/plugin")).toBe(true);
    expect(of("org.ow2.asm:asm")?.version).toBe("9.6");
    expect(of("gradle-wrapper")).toMatchObject({ role: "wrapper", version: "8.5" });
    expect(gradleVariables(["ext { springVersion = '6.1.1' }\next.lombok = '1.18.30'"], null)).toEqual(
      new Map([
        ["lombok", "1.18.30"],
        ["springVersion", "6.1.1"],
      ]),
    );
  });

  it("edits a build-file variable and map notation", () => {
    if (!main) throw new Error("no project");
    const kotlin = of("org.jetbrains.kotlin:kotlin-stdlib");
    const guava = of("com.google.guava:guava");
    if (!kotlin || !guava) throw new Error("inventory");
    const k = gradleEdits(tree, main, kotlin, "2.0.21");
    expect(k.find((e) => e.path === "build.gradle.kts")?.after).toContain('val kotlinVersion = "2.0.21"');
    expect(gradleEdits(tree, main, guava, "33.3.1-jre")[0]?.after).toContain('version = "33.3.1-jre"');
  });

  it("moves the wrapper with Gradle's own checksum when one is pinned", async () => {
    const wrapper = of("gradle-wrapper");
    if (!wrapper) throw new Error("no wrapper");
    const tx = await wrapperTransaction(tree, wrapper, "8.10.2", async () => null);
    expect(tx?.manifest[0]?.after).toContain("gradle-8.10.2-bin.zip");
    const pinned = memoryTree({
      "gradle/wrapper/gradle-wrapper.properties":
        "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.5-bin.zip\ndistributionSha256Sum=aaaa\n",
    });
    const refused = await wrapperTransaction(pinned, wrapper, "8.10.2", async () => null);
    expect(refused?.manifest).toEqual([]);
    expect(refused?.check?.({})).toContain("checksum");
  });
});
