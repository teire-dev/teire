import { describe, expect, it } from "vitest";
import { memoryTree } from "../src/inventory/tree";
import { locateBytecode } from "../src/locate/jvm-bytecode";

const tree = memoryTree({
  "src/main/java/com/acme/App.java":
    "package com.acme;\nimport okhttp3.OkHttpClient;\nclass App {\n  OkHttpClient c = new OkHttpClient();\n}\n",
  "src/main/java/com/acme/Quiet.java": "package com.acme;\nclass Quiet {}\n",
  // An Android variant's source set the scan's compile didn't build.
  "src/debug/java/com/acme/Debug.java": "package com.acme;\nclass Debug { okhttp3.Call call; }\n",
});

describe("JVM classes at scan time say which files compiled (S19)", () => {
  const probe = [
    "com/acme/App\tApp.java\t0\tclass\t\t\t",
    "com/acme/Quiet\tQuiet.java\t0\tclass\t\t\t",
    "com/acme/App\tApp.java\t4\tnew\tokhttp3/OkHttpClient\t<init>\t",
  ].join("\n");

  it("counts the compiled files and the uses that didn't compile", () => {
    const located = locateBytecode({
      probe,
      tree,
      declKeys: new Set(["okhttp3.OkHttpClient"]),
      packages: ["okhttp3"],
      projectRoot: ".",
    });
    expect(located.hits.map((h) => `${h.file}:${h.line}`)).toEqual(["src/main/java/com/acme/App.java:4"]);
    expect(located.coverage.filesScanned).toBe(2);
    expect(located.coverage.unresolvedSites).toBe(1);
    expect(located.coverage.filesSkipped[0]?.reason).toMatch(/did not compile/);
  });

  it("is clean only when every file that uses the library compiled", () => {
    const clean = locateBytecode({
      probe: `${probe}\ncom/acme/Debug\tDebug.java\t0\tclass\t\t\t`,
      tree,
      declKeys: new Set(["okhttp3.Interceptor"]),
      packages: ["okhttp3"],
      projectRoot: ".",
    });
    expect(clean.hits).toEqual([]);
    expect(clean.coverage).toMatchObject({ resolutionLevel: "type", unresolvedSites: 0, filesScanned: 3 });
  });
});
