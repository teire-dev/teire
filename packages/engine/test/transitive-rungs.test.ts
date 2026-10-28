import { describe, expect, it } from "vitest";
import type { DependencyInstance } from "../src/contract";
import { jvmTransaction } from "../src/fix/upgrade-jvm";
import { pyTransaction, uvOverrideEdit } from "../src/fix/upgrade-py";
import type { JvmProject } from "../src/inventory/jvm";
import type { PyProject } from "../src/inventory/python";
import { memoryTree } from "../src/inventory/tree";

// The transitive ladder (S15.7): Gradle constraints and uv overrides raise a package the
// packages depending on it hold back.
const transitive = (over: Partial<DependencyInstance>) =>
  ({
    ecosystem: "maven",
    name: "com.fasterxml.jackson.core:jackson-databind",
    version: "2.9.8",
    direct: false,
    scope: "prod",
    workspace: ":app",
    manifestPath: "app/build.gradle.kts",
    source: "registry",
    resolvedBy: "lockfile",
    ...over,
  }) as DependencyInstance;

describe("Gradle dependency constraint", () => {
  const lock = "com.fasterxml.jackson.core:jackson-databind:2.9.8=compileClasspath,runtimeClasspath\n";
  const project = {
    root: ".",
    manager: "gradle",
    modules: [
      { name: ":app", dir: "app", manifest: "app/build.gradle.kts", lockfile: "app/gradle.lockfile" },
      { name: ":cli", dir: "cli", manifest: "cli/build.gradle", lockfile: "cli/gradle.lockfile" },
      { name: ":docs", dir: "docs", manifest: "docs/build.gradle", lockfile: "docs/gradle.lockfile" },
    ],
  } as unknown as JvmProject;
  const tree = memoryTree({
    "app/build.gradle.kts":
      'plugins { java }\ndependencies {\n    implementation("org.example:lib:1.0")\n}\n',
    "cli/build.gradle": "dependencies {\n  implementation 'org.example:lib:1.0'\n}\n",
    "docs/build.gradle": "",
    "app/gradle.lockfile": lock,
    "cli/gradle.lockfile": lock,
    "docs/gradle.lockfile": "org.example:other:1.0=runtimeClasspath\n",
  });

  it("adds a constraint to every module whose lock holds the package, in each file's own DSL", () => {
    const tx = jvmTransaction(tree, project, transitive({}), "2.9.10.8", undefined, "Teire: fixes GHSA-x");
    expect(tx.manifest.map((e) => e.path)).toEqual(["app/build.gradle.kts", "cli/build.gradle"]);
    expect(tx.manifest[0]?.after).toContain(
      '    constraints {\n        implementation("com.fasterxml.jackson.core:jackson-databind:2.9.10.8") {\n            because("Teire: fixes GHSA-x")',
    );
    expect(tx.manifest[1]?.after).toContain(
      "  constraints {\n    implementation('com.fasterxml.jackson.core:jackson-databind:2.9.10.8') {",
    );
    expect(tx.manifest[0]?.after.startsWith(tx.manifest[0]?.before ?? "")).toBe(true);
  });

  it("checks only the locks that held the package", () => {
    const tx = jvmTransaction(tree, project, transitive({}), "2.9.10.8");
    const locked = "com.fasterxml.jackson.core:jackson-databind:2.9.10.8=compileClasspath\n";
    expect(tx.check?.({ "app/gradle.lockfile": locked, "cli/gradle.lockfile": locked })).toBeNull();
    expect(tx.check?.({ "app/gradle.lockfile": locked, "cli/gradle.lockfile": lock })).toContain(
      "cli/gradle.lockfile",
    );
  });
});

describe("uv override-dependencies", () => {
  const project = { root: ".", manager: "uv", lockfile: "uv.lock" } as unknown as PyProject;
  const head = '[project]\nname = "app"\ndependencies = ["requests"]\n';
  const edit = (pyproject: string) =>
    uvOverrideEdit(memoryTree({ "pyproject.toml": pyproject }), project, "urllib3", "2.2.2")?.after;

  it("adds a [tool.uv] table when there is none", () => {
    expect(edit(head)).toBe(`${head}\n[tool.uv]\noverride-dependencies = ["urllib3>=2.2.2"]\n`);
  });

  it("adds the key to an existing [tool.uv] table", () => {
    expect(edit(`${head}\n[tool.uv]\ndev-dependencies = []\n`)).toContain(
      '[tool.uv]\noverride-dependencies = ["urllib3>=2.2.2"]\ndev-dependencies = []',
    );
  });

  it("appends to a one-line and a multi-line list, and replaces the package's own entry", () => {
    expect(edit(`${head}\n[tool.uv]\noverride-dependencies = ["idna>=3.7"]\n`)).toContain(
      'override-dependencies = ["idna>=3.7", "urllib3>=2.2.2"]',
    );
    expect(edit(`${head}\n[tool.uv]\noverride-dependencies = [\n  "idna>=3.7",\n]\n`)).toContain(
      'override-dependencies = [\n  "idna>=3.7",\n  "urllib3>=2.2.2",\n]',
    );
    expect(edit(`${head}\n[tool.uv]\noverride-dependencies = ["urllib3==1.26.5"]\n`)).toContain(
      'override-dependencies = ["urllib3>=2.2.2"]',
    );
  });

  it("writes to the workspace root, where uv reads [tool.uv], not to the member", () => {
    const member = { root: "packages/api", manager: "uv", lockfile: "uv.lock" } as unknown as PyProject;
    const tree = memoryTree({
      "pyproject.toml": '[tool.uv.workspace]\nmembers = ["packages/*"]\n',
      "packages/api/pyproject.toml": head,
    });
    const e = uvOverrideEdit(tree, member, "urllib3", "2.2.2");
    expect(e?.path).toBe("pyproject.toml");
    expect(e?.after).toContain('[tool.uv]\noverride-dependencies = ["urllib3>=2.2.2"]');
  });

  it("is the fallback when the in-range uv lock can't reach the fix", () => {
    const tx = pyTransaction(
      memoryTree({ "pyproject.toml": head, "uv.lock": "" }),
      project,
      transitive({ ecosystem: "pypi", name: "urllib3", version: "1.26.5", manifestPath: "pyproject.toml" }),
      "2.2.2",
    );
    expect(tx.commands).toEqual([["uv", "lock", "--upgrade-package", "urllib3==2.2.2"]]);
    expect(tx.fallback?.manifest[0]?.path).toBe("pyproject.toml");
    expect(tx.fallback?.commands).toEqual([["uv", "lock", "--upgrade-package", "urllib3"]]);
  });
});

describe("Maven dependencyManagement pin", () => {
  const project = { root: ".", manager: "maven", manifest: "pom.xml", modules: [] } as unknown as JvmProject;
  const pom = (managed = "") =>
    `<project>\n  <modelVersion>4.0.0</modelVersion>\n${managed}  <dependencies>\n    <dependency>\n      <groupId>org.example</groupId>\n      <artifactId>lib</artifactId>\n      <version>1.0</version>\n    </dependency>\n  </dependencies>\n</project>\n`;
  const pin = (xml: string) =>
    jvmTransaction(
      memoryTree({ "pom.xml": xml }),
      project,
      transitive({ manifestPath: "pom.xml" }),
      "2.9.10.8",
    );

  it("adds a managed version before <dependencies> when the POM has none", () => {
    const tx = pin(pom());
    expect(tx.manifest[0]?.after).toContain(
      "  <dependencyManagement>\n    <dependencies>\n      <dependency>\n        <groupId>com.fasterxml.jackson.core</groupId>\n        <artifactId>jackson-databind</artifactId>\n        <version>2.9.10.8</version>\n      </dependency>\n    </dependencies>\n  </dependencyManagement>\n  <dependencies>",
    );
    expect(tx.check?.({ "pom.xml": tx.manifest[0]?.after ?? "" })).toBeNull();
  });

  it("moves an existing managed version and keeps the other entries", () => {
    const managed =
      "  <dependencyManagement>\n    <dependencies>\n      <dependency>\n        <groupId>com.fasterxml.jackson.core</groupId>\n        <artifactId>jackson-databind</artifactId>\n        <version>2.9.8</version>\n      </dependency>\n      <dependency>\n        <groupId>org.other</groupId>\n        <artifactId>x</artifactId>\n        <version>3.0</version>\n      </dependency>\n    </dependencies>\n  </dependencyManagement>\n";
    const after = pin(pom(managed)).manifest[0]?.after ?? "";
    expect(after).toContain("<artifactId>jackson-databind</artifactId>\n        <version>2.9.10.8</version>");
    expect(after).toContain("<artifactId>x</artifactId>\n        <version>3.0</version>");
    expect(after.match(/<dependencyManagement>/g)).toHaveLength(1);
  });

  it("ignores a profile's section and pins in the project's own (stage R review)", () => {
    const profile =
      "  <profiles>\n    <profile>\n      <dependencyManagement>\n        <dependencies>\n        </dependencies>\n      </dependencyManagement>\n    </profile>\n  </profiles>\n";
    const after = pin(pom().replace("</project>", `${profile}</project>`)).manifest[0]?.after ?? "";
    expect(after.match(/<dependencyManagement>/g)).toHaveLength(2);
    expect(after.indexOf("jackson-databind")).toBeLessThan(after.indexOf("<profiles>"));
  });
});
