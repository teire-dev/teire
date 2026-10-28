import { describe, expect, it } from "vitest";
import { memoryTree } from "../src/inventory/tree";
import { runtimesOf } from "../src/pipeline/runtimes";

describe("runtime lines in Go, Ruby, Rust and Java repos (S16.4)", () => {
  const tree = memoryTree({
    "svc/go.mod": "module example.com/svc\n\ngo 1.21\n\ntoolchain go1.22.5\n",
    "app/.ruby-version": "ruby-3.1.4\n",
    "cli/rust-toolchain.toml": '[toolchain]\nchannel = "1.70.0"\n',
    "api/build.gradle.kts": "java {\n  toolchain { languageVersion = JavaLanguageVersion.of(11) }\n}\n",
    "legacy/pom.xml":
      "<project><properties><maven.compiler.source>1.8</maven.compiler.source></properties></project>",
    "edge/rust-toolchain": "stable\n",
  });
  const uses = runtimesOf(tree, [], [], {
    go: [{ root: "svc" }],
    ruby: [{ root: "app" }],
    rust: [{ root: "cli" }, { root: "edge" }],
    jvm: [{ root: "api" }, { root: "legacy" }],
  });
  const line = (runtime: string, file: string) => uses.find((u) => u.runtime === runtime && u.file === file);

  it("reads the line each repo actually runs", () => {
    expect(line("go", "svc/go.mod")).toMatchObject({ line: "1.22", lineNo: 5 });
    expect(line("ruby", "app/.ruby-version")?.line).toBe("3.1");
    expect(line("rust", "cli/rust-toolchain.toml")?.line).toBe("1.70");
    expect(line("java", "api/build.gradle.kts")?.line).toBe("11");
    expect(line("java", "legacy/pom.xml")?.line).toBe("8");
  });

  it("leaves a moving channel alone", () => {
    expect(uses.some((u) => u.file === "edge/rust-toolchain")).toBe(false);
  });
});
