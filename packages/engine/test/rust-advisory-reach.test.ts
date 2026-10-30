import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryTree } from "../src/inventory/tree";
import { locateRust } from "../src/locate/rust";

describe("RustSec's named functions, located in the code (S19)", () => {
  it("finds a call through the imported type and by full path, to the line", () => {
    const files = {
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\ntime = "0.1"\n',
      "src/main.rs":
        'use time::OffsetDateTime;\n\nfn main() {\n    let now = OffsetDateTime::now_local();\n    let t = time::now();\n    println!("{:?} {:?}", now, t);\n}\n',
      "src/other.rs": "fn quiet() -> u32 { 1 }\n",
    };
    const repoDir = mkdtempSync(join(tmpdir(), "teire-rustsec-"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repoDir, path)), { recursive: true });
      writeFileSync(join(repoDir, path), text);
    }
    // RUSTSEC-2020-0071's affects.functions.
    const located = locateRust({
      repoDir,
      tree: memoryTree(files),
      projectRoot: ".",
      crate: "time",
      declKeys: new Set(["time::OffsetDateTime::now_local", "time::now", "time::at_utc"]),
      manifests: ["Cargo.toml"],
    });
    expect(located.hits.map((h) => `${h.declKey} ${h.file}:${h.line} ${h.kind}`).sort()).toEqual([
      "time::OffsetDateTime::now_local src/main.rs:4 call",
      "time::now src/main.rs:5 call",
    ]);
  });
});
