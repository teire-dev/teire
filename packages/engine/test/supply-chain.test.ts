import { describe, expect, it } from "vitest";
import { type NpmVersionDetail, supplyChainSignals } from "../src/registry";

const version = (v: string, extra: Partial<NpmVersionDetail>) =>
  ({ version: v, ...extra }) as NpmVersionDetail;

describe("supply-chain signals between the installed version and the target (D-14)", () => {
  it("names a new install script, a new publisher and lost provenance", () => {
    const from = version("1.0.0", { publisher: "alice", installScripts: [], provenance: true });
    const to = version("2.0.0", { publisher: "mallory", installScripts: ["postinstall"], provenance: false });
    const signals = supplyChainSignals(from, to);
    expect(signals).toHaveLength(3);
    expect(signals[0]).toContain("`postinstall`");
    expect(signals[1]).toContain("`mallory`");
    expect(signals[2]).toContain("no provenance attestation");
  });

  it("says nothing when the fields are unknown (cached before they were read) or unchanged", () => {
    expect(
      supplyChainSignals(version("1.0.0", {}), version("2.0.0", { installScripts: ["install"] })),
    ).toEqual([]);
    const same = { publisher: "alice", installScripts: ["install"], provenance: true };
    expect(supplyChainSignals(version("1.0.0", same), version("2.0.0", same))).toEqual([]);
  });
});
