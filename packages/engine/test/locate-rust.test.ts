import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { directoryTree } from "../src/inventory/tree";
import { locateRust } from "../src/locate/rust";

describe("Rust sites, resolved by import where the file says so (R21.7)", () => {
  const dir = mkdtempSync(join(tmpdir(), "teire-locate-rust-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src/dice.rs"),
    [
      "use rand::{",
      "    thread_rng,",
      "    Rng,",
      "};",
      "fn roll() -> u8 {",
      "    let mut r = thread_rng();",
      "    r.gen_range(1..7)",
      "}",
      "fn seed() -> u64 { rand::thread_rng().gen() }",
    ].join("\n"),
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const { hits } = locateRust({
    repoDir: dir,
    tree: directoryTree(dir),
    projectRoot: ".",
    crate: "rand",
    declKeys: new Set(["rand::thread_rng", "Rng::gen_range"]),
    manifests: [],
  });
  const at = (line: number, key: string) => hits.find((h) => h.line === line && h.declKey === key);

  it("marks the multi-line use group, the bare call it imports and the full path as imports", () => {
    expect(at(2, "rand::thread_rng")).toMatchObject({ kind: "import", resolution: "import" });
    expect(at(6, "rand::thread_rng")).toMatchObject({ kind: "call", resolution: "import", column: 17 });
    expect(at(9, "rand::thread_rng")).toMatchObject({ resolution: "import" });
  });

  it("keeps a trait method on an unknown receiver by name only", () => {
    expect(at(7, "Rng::gen_range")).toMatchObject({ kind: "call", resolution: "name-only" });
  });
});
