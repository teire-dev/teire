import { describe, expect, it } from "vitest";
import { readRustInventory } from "../src/inventory/rust";
import { memoryTree } from "../src/inventory/tree";
import { cargoRange, cargoScheme } from "../src/registry/versions";
import { parseSemverChecks, removedFeatures } from "../src/surface/cargo";

const REPORT = `     Checked [   7.491s] 202 checks: 191 pass, 11 fail, 0 warn, 58 skip

--- failure feature_missing: package feature removed or renamed ---

Description:
A feature has been removed from this package's Cargo.toml.
        ref: https://doc.rust-lang.org/cargo/reference/semver.html#cargo-feature-remove

Failed in:
  feature assistant-types in the package's Cargo.toml
  feature assistant in the package's Cargo.toml

--- failure module_missing: pub module removed or renamed ---

Description:
A publicly-visible module cannot be imported by its prior path.

Failed in:
  mod async_openai::types::assistants, previously in file /r/async-openai-0.41.3/src/types/assistants/mod.rs:1

--- failure inherent_method_missing: pub method removed or renamed ---

Description:
A publicly-visible method or associated fn is no longer available under its prior name.

Failed in:
  Client::assistants, previously in file /r/async-openai-0.41.3/src/client.rs:264
  Client::threads, previously in file /r/async-openai-0.41.3/src/client.rs:274

     Summary semver requires new major version: 11 major and 0 minor checks failed
`;

describe("cargo-semver-checks reports (real output, async-openai 0.41.3 → 0.42.2)", () => {
  it("turns each Failed-in line into a change keyed by its Rust path", () => {
    const changes = parseSemverChecks(REPORT);
    expect(changes.map((c) => [c.kind, c.symbolKind, c.path])).toEqual([
      ["removed", "module", "feature:assistant-types"],
      ["removed", "module", "feature:assistant"],
      ["removed", "module", "async_openai::types::assistants"],
      ["removed", "method", "Client::assistants"],
      ["removed", "method", "Client::threads"],
    ]);
    expect(changes.every((c) => c.severity === "breaking")).toBe(true);
  });

  it("finds removed features from the index lines", () => {
    expect(
      removedFeatures({ default: [], assistant: [], realtime: [] }, { default: [], realtime: [] }),
    ).toEqual(["assistant"]);
  });
});

describe("Cargo versions and requirements", () => {
  it("reads a bare requirement as caret and a comma as AND", () => {
    expect(cargoRange("0.8")).toBe("^0.8");
    expect(cargoRange(">=1.2, <1.5")).toBe(">=1.2 <1.5");
    expect(cargoScheme.satisfies("0.8.8", "0.8")).toBe(true);
    expect(cargoScheme.satisfies("0.9.0", "0.8")).toBe(false);
    expect(cargoScheme.breaking("0.8.8", "0.10.3")).toBe(true);
  });
});

describe("Cargo inventory", () => {
  it("reads workspace members, inherited dependencies, renames and the exact locked version", () => {
    const tree = memoryTree({
      "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\nrand = "0.8"\n`,
      "crates/app/Cargo.toml": `[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nrand = { workspace = true }\nopenai = { package = "async-openai", version = "0.41" }\n\n[dev-dependencies]\nrand_chacha = "0.3"\n`,
      "Cargo.lock": `version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "async-openai",\n "rand 0.8.8",\n "rand_chacha",\n]\n\n[[package]]\nname = "rand"\nversion = "0.8.8"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "rand"\nversion = "0.9.5"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "async-openai"\nversion = "0.41.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "rand_chacha"\nversion = "0.3.1"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`,
    });
    const [project] = readRustInventory(tree);
    expect(project?.lockfileVersion).toBe("4");
    const direct = project?.instances
      .filter((i) => i.direct)
      .map((i) => [i.name, i.version, i.scope, i.aliasName ?? ""]);
    expect(direct).toEqual([
      ["rand", "0.8.8", "prod", ""],
      ["async-openai", "0.41.3", "prod", "openai"],
      ["rand_chacha", "0.3.1", "dev", ""],
    ]);
    expect(project?.instances.filter((i) => !i.direct).map((i) => `${i.name}@${i.version}`)).toEqual([
      "rand@0.9.5",
    ]);
  });
});
