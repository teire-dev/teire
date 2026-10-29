import { describe, expect, it } from "vitest";
import type { DependencyInstance } from "../src/contract";
import { cargoBlockers } from "../src/fix/upgrade-rust";
import type { IndexLine } from "../src/registry/cargo";

const line = (name: string, vers: string, extra: Partial<IndexLine> = {}): IndexLine => ({
  name,
  vers,
  yanked: false,
  features: {},
  deps: [],
  ...extra,
});

const direct = (name: string, version: string, declaredRange: string) =>
  ({ name, version, declaredRange, direct: true }) as DependencyInstance;

const index: Record<string, IndexLine[]> = {
  serde: ["1.0.100", "1.0.150", "1.0.151", "1.0.200", "2.0.0-alpha.1"].map((v) => line("serde", v)),
  http: ["0.2.9", "0.2.12", "1.0.0", "1.1.0"].map((v) => line("http", v)),
  "openssl-sys": ["0.9.60", "0.9.100", "0.10.0"].map((v) => line("openssl-sys", v, { links: "openssl" })),
  rand: ["0.8.5", "0.9.0"].map((v) => line("rand", v)),
};

const target = line("tower-x", "2.0.0", {
  deps: [
    { name: "serde", req: "^1.0.150" },
    { name: "http", req: "^1.0" },
    { name: "openssl-sys", req: "^0.10" },
    { name: "rand", req: "^0.9", kind: "dev" },
    { name: "tokio", req: "^1" },
  ],
});

describe("Cargo blockers (D-9: no full unlock in dependabot-core for Rust)", () => {
  it("raises a pinned crate in the same line to the lowest version the target accepts", () => {
    const blockers = cargoBlockers(target, [direct("serde", "1.0.100", "=1.0.100")], (c) => index[c] ?? []);
    expect(blockers).toEqual([
      { name: "serde", from: "1.0.100", to: "1.0.150", need: "^1.0.150", have: "=1.0.100" },
    ]);
  });

  it("leaves a crate the target needs in another line alone: Cargo keeps both", () => {
    expect(cargoBlockers(target, [direct("http", "0.2.12", "0.2")], (c) => index[c] ?? [])).toEqual([]);
  });

  it("raises a links crate across lines: only one may be in the build", () => {
    const [b] = cargoBlockers(target, [direct("openssl-sys", "0.9.100", "0.9")], (c) => index[c] ?? []);
    expect(b).toMatchObject({ name: "openssl-sys", to: "0.10.0" });
  });

  it("ignores dev dependencies, crates already satisfied, and crates the repo doesn't declare", () => {
    expect(
      cargoBlockers(
        target,
        [direct("rand", "0.8.5", "0.8"), direct("serde", "1.0.200", "1")],
        (c) => index[c] ?? [],
      ),
    ).toEqual([]);
  });

  it("follows a renamed dependency to its real crate", () => {
    const renamed = line("x", "1.0.0", {
      deps: [{ name: "serde_crate", package: "serde", req: "^1.0.150" }],
    });
    const [b] = cargoBlockers(renamed, [direct("serde", "1.0.100", "~1.0.100")], (c) => index[c] ?? []);
    expect(b?.name).toBe("serde");
  });
});
