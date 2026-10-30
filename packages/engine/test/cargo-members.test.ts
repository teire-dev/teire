import { describe, expect, it } from "vitest";
import { readRustInventory } from "../src/inventory/rust";
import type { RepoTree } from "../src/inventory/tree";

const tree = (files: Record<string, string>): RepoTree => ({
  files: () => Object.keys(files),
  read: (p) => files[p] ?? null,
});

describe("Cargo workspace members as Cargo sees them (D-24)", () => {
  it("expands ** and adds path dependencies inside the workspace as members", () => {
    const [project] = readRustInventory(
      tree({
        "Cargo.toml": '[workspace]\nmembers = ["crates/**"]\nexclude = ["crates/old"]\n',
        "crates/core/Cargo.toml":
          '[package]\nname = "core"\n[dependencies]\nserde = "1"\nutil = { path = "../../libs/util" }\n',
        "crates/net/http/Cargo.toml": '[package]\nname = "http"\n[dependencies]\nreqwest = "0.12"\n',
        "crates/old/Cargo.toml": '[package]\nname = "old"\n[dependencies]\nrand = "0.7"\n',
        "libs/util/Cargo.toml":
          '[package]\nname = "util"\n[dependencies]\nitoa = "1"\nshared = { path = "../shared" }\n',
        "libs/shared/Cargo.toml": '[package]\nname = "shared"\n[dependencies]\nbytes = "1"\n',
      }),
    );
    const names = new Set(project?.instances.map((i) => i.name));
    expect(names.has("serde")).toBe(true);
    expect(names.has("reqwest")).toBe(true); // crates/net/http, two folders deep
    expect(names.has("itoa")).toBe(true); // libs/util, a path dependency of a member
    expect(names.has("bytes")).toBe(true); // libs/shared, a path dependency of that one
    expect(names.has("rand")).toBe(false); // excluded
    expect(project?.instances.find((i) => i.name === "serde")).toMatchObject({
      version: null,
      declaredRange: "1",
    });
  });
});
