import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { gradleEdits, jvmTransaction, mavenEdit } from "../src/fix/upgrade-jvm";
import { gradleIncludes, parseGradleLockfile, readCatalog, readJvmInventory } from "../src/inventory/jvm";
import { directoryTree, memoryTree } from "../src/inventory/tree";
import { locateJvm, maskJvm } from "../src/locate/jvm";
import { compareMaven, isMavenPrerelease, mavenFlavor, mavenSatisfies } from "../src/registry/maven-version";
import { parseJapicmp } from "../src/surface/jvm";
import { countsFromOutput } from "../src/verify/reports";

describe("Maven version order (ComparableVersion)", () => {
  it("sorts qualifiers as Maven does", () => {
    const sorted = [
      "1.0-alpha-1",
      "1.0-beta-1",
      "1.0-m1",
      "1.0-rc1",
      "1.0-SNAPSHOT",
      "1.0",
      "1.0-sp1",
      "1.0.1",
      "1.1",
      "10.0",
    ];
    expect([...sorted].reverse().sort(compareMaven)).toEqual(sorted);
    expect(compareMaven("1.0", "1.0.0")).toBe(0);
    expect(compareMaven("33.4.0-android", "33.4.0-jre")).toBe(-1);
  });

  it("reads prereleases, flavors and ranges", () => {
    expect(isMavenPrerelease("5.0.0-alpha.14")).toBe(true);
    expect(isMavenPrerelease("33.4.0-jre")).toBe(false);
    expect(mavenFlavor("33.4.0-jre")).toBe("jre");
    expect(mavenFlavor("1.0.0.Final")).toBe("");
    expect(mavenSatisfies("2.13.4", ">= 2.0, < 2.13.4.2")).toBe(true);
    expect(mavenSatisfies("1.3", "[1.0,1.2),[1.5,)")).toBe(false);
  });
});

const POM_PARENT = `<project><modelVersion>4.0.0</modelVersion><groupId>d</groupId><artifactId>parent</artifactId><version>1</version>
  <modules><module>app</module></modules>
  <properties><!-- HTTP --><okhttp.version>3.14.9</okhttp.version></properties>
  <dependencyManagement><dependencies><dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>19.0</version></dependency></dependencies></dependencyManagement>
</project>`;
const POM_APP = `<project><modelVersion>4.0.0</modelVersion><parent><groupId>d</groupId><artifactId>parent</artifactId><version>1</version></parent>
  <artifactId>app</artifactId>
  <dependencies>
    <dependency><groupId>com.squareup.okhttp3</groupId><artifactId>okhttp</artifactId><version>\${okhttp.version}</version></dependency>
    <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId></dependency>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.11.4</version><scope>test</scope></dependency>
    <dependency><groupId>io.remote</groupId><artifactId>managed</artifactId></dependency>
  </dependencies>
</project>`;

describe("JVM inventory", () => {
  it("interpolates parent properties and local managed versions; leaves remote ones unresolved", () => {
    const [p] = readJvmInventory(memoryTree({ "pom.xml": POM_PARENT, "app/pom.xml": POM_APP }));
    const by = (n: string) => p?.instances.find((i) => i.name === n);
    expect(by("com.squareup.okhttp3:okhttp")).toMatchObject({
      version: "3.14.9",
      resolvedBy: "toolchain",
      workspace: "app",
    });
    expect(by("com.google.guava:guava")?.version).toBe("19.0");
    expect(by("org.junit.jupiter:junit-jupiter")?.scope).toBe("test");
    expect(by("io.remote:managed")).toMatchObject({ version: null, resolvedBy: "unresolved" });
  });

  it("reads Gradle catalogs, includes and lockfiles", () => {
    expect(gradleIncludes(`include(":app", ":lib")\ninclude 'tools'`)).toEqual([":app", ":lib", ":tools"]);
    const catalog = readCatalog(
      `[versions]\nokhttp = "3.14.9"\n[libraries]\nokhttp-core = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }\n`,
    );
    expect(catalog.libraries.get("okhttp.core")).toMatchObject({
      module: "com.squareup.okhttp3:okhttp",
      version: "3.14.9",
      ref: "okhttp",
    });
    expect(
      parseGradleLockfile("# x\ncom.a:b:1.0=compileClasspath,runtimeClasspath\nempty=annotationProcessor\n"),
    ).toEqual([
      { name: "com.a:b", version: "1.0", configurations: ["compileClasspath", "runtimeClasspath"] },
    ]);
    const [p] = readJvmInventory(
      memoryTree({
        "settings.gradle.kts": `rootProject.name = "x"`,
        "build.gradle.kts": `dependencies {\n  implementation(libs.okhttp.core)\n  testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")\n}`,
        "gradle/libs.versions.toml": `[versions]\nokhttp = "3.14.9"\n[libraries]\nokhttp-core = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }\n`,
        "gradle.lockfile":
          "com.squareup.okhttp3:okhttp:3.14.9=compileClasspath,runtimeClasspath\ncom.squareup.okio:okio:1.17.2=compileClasspath,runtimeClasspath\n",
      }),
    );
    expect(p?.instances.find((i) => i.name === "com.squareup.okhttp3:okhttp")).toMatchObject({
      version: "3.14.9",
      resolvedBy: "lockfile",
      direct: true,
    });
    expect(p?.instances.find((i) => i.name === "com.squareup.okio:okio")).toMatchObject({
      direct: false,
      version: "1.17.2",
    });
    expect(p?.instances.find((i) => i.name === "org.junit.jupiter:junit-jupiter")?.scope).toBe("test");
  });
});

const JAPICMP = `<?xml version="1.0"?><japicmp><classes>
<class changeStatus="MODIFIED" fullyQualifiedName="com.google.common.base.Objects" binaryCompatible="false" sourceCompatible="false"><compatibilityChanges/>
  <methods>
    <method changeStatus="REMOVED" name="toStringHelper" binaryCompatible="false" sourceCompatible="false"><compatibilityChanges><compatibilityChange type="METHOD_REMOVED"/></compatibilityChanges><parameters><parameter type="java.lang.Object"/></parameters></method>
  </methods><constructors/><fields/></class>
<class changeStatus="MODIFIED" fullyQualifiedName="com.google.common.base.MoreObjects" binaryCompatible="true" sourceCompatible="true"><compatibilityChanges/>
  <methods><method changeStatus="UNCHANGED" name="toStringHelper"><modifiers><modifier newValue="PUBLIC"/></modifiers><parameters><parameter type="java.lang.Object"/></parameters></method></methods></class>
<class changeStatus="MODIFIED" fullyQualifiedName="com.google.common.util.concurrent.Futures" binaryCompatible="false" sourceCompatible="false"><compatibilityChanges/>
  <methods>
    <method changeStatus="REMOVED" name="transform" binaryCompatible="false"><compatibilityChanges><compatibilityChange type="METHOD_REMOVED"/></compatibilityChanges><parameters><parameter type="a.F"/><parameter type="a.Fn"/></parameters></method>
  </methods></class>
<class changeStatus="NEW" fullyQualifiedName="okhttp3.HttpUrl$Companion"><methods>
  <method changeStatus="NEW" name="-deprecated_parse"><annotations><annotation changeStatus="NEW" fullyQualifiedName="kotlin.Deprecated"><elements>
    <element name="level" changeStatus="NEW"><newElementValues><newElementValue value="ERROR"/></newElementValues></element>
    <element name="message" changeStatus="NEW"><newElementValues><newElementValue value="moved to extension function"/></newElementValues></element>
    <element name="replaceWith" changeStatus="NEW"><newElementValues><newElementValue value="n.a."><values><value name="expression" value="url.toHttpUrlOrNull()"/></values></newElementValue></newElementValues></element>
  </elements></annotation></annotations><parameters><parameter type="java.lang.String"/></parameters></method>
</methods></class>
</classes></japicmp>`;

describe("japicmp report → surface changes", () => {
  it("keys removals, points at where a name moved, and lists surviving overloads", () => {
    const members = new Map([
      [
        "com.google.common.util.concurrent.Futures#transform",
        [["a.F", "a.Fn", "java.util.concurrent.Executor"]],
      ],
    ]);
    const changes = parseJapicmp(JAPICMP, members);
    const helper = changes.find((c) => c.declKey === "com.google.common.base.Objects#toStringHelper");
    expect(helper).toMatchObject({
      kind: "removed",
      guidance: "`toStringHelper` now on com.google.common.base.MoreObjects",
    });
    const transform = changes.find(
      (c) => c.declKey === "com.google.common.util.concurrent.Futures#transform",
    );
    expect(transform).toMatchObject({
      kind: "arity-changed",
      after: "transform(a.F, a.Fn, java.util.concurrent.Executor)",
    });
  });

  it("turns new ERROR-level Kotlin deprecations into kotlin: removals with their replacement", () => {
    const parse = parseJapicmp(JAPICMP).find((c) => c.declKey === "kotlin:okhttp3.HttpUrl#parse");
    expect(parse?.after).toBe("url.toHttpUrlOrNull()");
    expect(parse?.guidance).toContain("moved to extension function");
  });
});

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "teire-jvm-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { dir, tree: directoryTree(dir) };
}

describe("JVM locator", () => {
  it("masks comments and strings without moving offsets", () => {
    const src = `a("x // y"); // z\n/* q */ b();`;
    expect(maskJvm(src).length).toBe(src.length);
    expect(maskJvm(src)).not.toContain("z");
  });

  it("resolves statics through imports, skips calls a surviving overload accepts, keeps kotlin: keys to Kotlin", () => {
    const { dir, tree } = repo({
      "src/main/java/d/Tags.java": `package d;\nimport com.google.common.base.Objects;\nimport com.google.common.util.concurrent.Futures;\nclass Tags {\n  String s() { return Objects.toStringHelper(this).toString(); }\n  Object a() { return Futures.transform(f, fn); }\n  Object b() { return Futures.transform(f, fn, ex); }\n  // Objects.toStringHelper(this) in a comment\n}\n`,
      "src/main/kotlin/d/Hook.kt": `package d\nimport okhttp3.HttpUrl\nval u = HttpUrl.parse("https://x")\n`,
      "src/main/java/d/Other.java": `package d;\nimport okhttp3.HttpUrl;\nclass Other { Object u = HttpUrl.parse("x"); }\n`,
    });
    const located = locateJvm({
      repoDir: dir,
      tree,
      projectRoot: ".",
      packages: ["com.google.common.base", "com.google.common.util.concurrent", "okhttp3"],
      declKeys: new Set([
        "com.google.common.base.Objects#toStringHelper",
        "com.google.common.util.concurrent.Futures#transform",
        "kotlin:okhttp3.HttpUrl#parse",
      ]),
      aritiesLeft: new Map([["com.google.common.util.concurrent.Futures#transform", [3]]]),
    });
    const sites = located.hits.map((h) => `${h.file}:${h.line} ${h.declKey}`).sort();
    expect(sites).toEqual([
      "src/main/java/d/Tags.java:5 com.google.common.base.Objects#toStringHelper",
      "src/main/java/d/Tags.java:6 com.google.common.util.concurrent.Futures#transform",
      "src/main/kotlin/d/Hook.kt:3 kotlin:okhttp3.HttpUrl#parse",
    ]);
  });
});

describe("JVM transactions", () => {
  it("moves a POM property defined in the parent, keeping its comment", () => {
    const tree = memoryTree({ "pom.xml": POM_PARENT, "app/pom.xml": POM_APP });
    const [p] = readJvmInventory(tree);
    const okhttp = p?.instances.find((i) => i.name === "com.squareup.okhttp3:okhttp");
    const edit = mavenEdit(tree, p as NonNullable<typeof p>, okhttp as NonNullable<typeof okhttp>, "4.12.0");
    expect(edit?.path).toBe("pom.xml");
    expect(edit?.after).toContain("<!-- HTTP --><okhttp.version>4.12.0</okhttp.version>");
    const guava = p?.instances.find((i) => i.name === "com.google.guava:guava");
    expect(
      mavenEdit(tree, p as NonNullable<typeof p>, guava as NonNullable<typeof guava>, "33.7.2-jre")?.after,
    ).toContain("<artifactId>guava</artifactId><version>33.7.2-jre</version>");
  });

  it("moves a catalog version.ref and asks for --update-locks where a lockfile exists", () => {
    const tree = memoryTree({
      "settings.gradle.kts": `rootProject.name = "x"`,
      "build.gradle.kts": `dependencies { implementation(libs.okhttp) }`,
      "gradle/libs.versions.toml": `[versions]\n# HTTP\nokhttp = "3.14.9"\n[libraries]\nokhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }\n`,
      "gradle.lockfile": "com.squareup.okhttp3:okhttp:3.14.9=compileClasspath\n",
    });
    const [p] = readJvmInventory(tree);
    const okhttp = p?.instances.find((i) => i.name === "com.squareup.okhttp3:okhttp");
    const edits = gradleEdits(
      tree,
      p as NonNullable<typeof p>,
      okhttp as NonNullable<typeof okhttp>,
      "5.5.0",
    );
    expect(edits[0]?.after).toContain(`# HTTP\nokhttp = "5.5.0"`);
    const t = jvmTransaction(tree, p as NonNullable<typeof p>, okhttp as NonNullable<typeof okhttp>, "5.5.0");
    expect(t.commands).toEqual([["teire-jvm", "lock-gradle", "com.squareup.okhttp3:okhttp", ":"]]);
    expect(
      t.check?.({
        "gradle/libs.versions.toml": "",
        "gradle.lockfile": "com.squareup.okhttp3:okhttp:5.5.0=compileClasspath\n",
      }),
    ).toBeNull();
  });
});

describe("JVM test counts", () => {
  it("sums surefire module summaries and Teire's Gradle lines", () => {
    expect(
      countsFromOutput(
        "[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s -- in d.A\n[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0\n[INFO] Tests run: 2, Failures: 0, Errors: 1, Skipped: 1\n",
      ),
    ).toEqual({ collected: 6, passed: 3, failed: 1, skipped: 1, errors: 1 });
    expect(countsFromOutput("TEIRE-TESTS total=3 passed=3 failed=0 skipped=0\n")).toEqual({
      collected: 3,
      passed: 3,
      failed: 0,
      skipped: 0,
      errors: 0,
    });
  });
});
