import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { directoryTree } from "../src/inventory/tree";
import { locateRust } from "../src/locate/rust";
import { mergeScip, parseRustSymbol, readScipIndex } from "../src/locate/rust-scip";

// A real index: rust-analyzer 1.99.1's `scip` on fixtures/rust-scip (semver 1.0.23), made in the
// Rust sandbox image.
const dir = resolve(import.meta.dirname, "../../../fixtures/rust-scip");
const bytes = readFileSync(resolve(dir, "index.scip"));

describe("rust-analyzer's SCIP index as type-resolved sites (S19)", () => {
  it("reads crate, version, owner and item from a symbol", () => {
    expect(parseRustSymbol("rust-analyzer cargo semver 1.0.23 impl#[Version]parse().")).toEqual({
      crate: "semver",
      version: "1.0.23",
      owner: "Version",
      name: "parse",
    });
    expect(
      parseRustSymbol("rust-analyzer cargo reqwest 0.13.5 async_impl/client/impl#[Client]post().")?.owner,
    ).toBe("Client");
    expect(parseRustSymbol("rust-analyzer cargo semver 1.0.23 VersionReq#")).toMatchObject({
      owner: null,
      name: "VersionReq",
    });
    expect(parseRustSymbol("local 0")).toBeNull();
  });

  it("locates the used items by type and leaves the unused one clean", () => {
    const declKeys = new Set(["semver::Version::parse", "semver::VersionReq::matches", "semver::Comparator"]);
    const lexical = locateRust({
      repoDir: dir,
      tree: directoryTree(dir),
      projectRoot: ".",
      crate: "semver",
      declKeys,
      manifests: ["Cargo.toml"],
    });
    const lines = readFileSync(resolve(dir, "src/main.rs"), "utf8").split("\n");
    const merged = mergeScip(lexical, readScipIndex(bytes, "semver"), {
      projectRoot: ".",
      version: "1.0.23",
      declKeys,
      sourceFiles: ["src/main.rs"],
      lineOf: (_file, line) => lines[line - 1] ?? "",
    });
    expect(merged.hits.map((h) => `${h.declKey} ${h.file}:${h.line} ${h.resolution}`).sort()).toEqual([
      "semver::Version::parse src/main.rs:4 type",
      "semver::VersionReq::matches src/main.rs:6 type",
    ]);
    expect(merged.coverage).toMatchObject({ resolutionLevel: "type", unresolvedSites: 0 });
    // An index of another version of the crate says nothing about this one: the lexical result
    // stands, with why, and never reads as no use (S19 review B5).
    const other = mergeScip(lexical, readScipIndex(bytes, "semver"), {
      projectRoot: ".",
      version: "1.0.0",
      declKeys,
      sourceFiles: ["src/main.rs"],
      lineOf: () => "",
    });
    expect(other.hits).toEqual(lexical.hits);
    expect(other.coverage.resolutionLevel).toBe(lexical.coverage.resolutionLevel);
    expect(other.coverage.unresolvedSites).toBeGreaterThan(0);
    expect(other.coverage.filesSkipped.at(-1)?.reason).toBe(
      "rust-analyzer indexed 1.0.23, not the compared 1.0.0",
    );
  });
});
