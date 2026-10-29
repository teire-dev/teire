import { describe, expect, it } from "vitest";
import { coMovedFindings, coMovedToDiff, jumpRank, usageCell, usageOf, withUsage } from "../src/fix/co-moved";
import type { FindingDraft } from "../src/impact";

const finding = (sites: number, reason = "removed `HeaderMap::get_all`") =>
  ({
    reason,
    verdict: "affected",
    callSites: Array.from({ length: sites }, (_, i) => ({
      path: "src/main.rs",
      line: i + 1,
      column: 1,
      snippet: "x",
    })),
  }) as unknown as FindingDraft;

describe("co-moved packages (D-10)", () => {
  it("ranks a major (or a 0.x minor) above a minor above a patch", () => {
    expect(jumpRank("0.2.9", "1.0.0")).toBe(3);
    expect(jumpRank("0.11.0", "0.12.0")).toBe(3);
    expect(jumpRank("1.2.0", "1.3.0")).toBe(2);
    expect(jumpRank("1.2.0", "1.2.4")).toBe(1);
    expect(jumpRank("v2.1.0", "v3.0.0")).toBe(3);
    expect(jumpRank("abc", "1.0.0")).toBe(3);
  });

  it("diffs only changed packages besides the lead, largest jumps first, past the cap listed", () => {
    const moved = [
      { name: "reqwest", from: "0.11.27", to: "0.12.9" },
      { name: "http", from: "0.2.12", to: "1.2.0" },
      { name: "bytes", from: "1.5.0", to: "1.9.0" },
      { name: "itoa", from: "1.0.10", to: "1.0.14" },
      { name: "old", from: "1.0.0", to: null, removed: true },
      { name: "same", from: "2.0.0", to: "2.0.0" },
      { name: "hyper", from: "0.14.28", to: "1.5.1" },
    ];
    const { diff, capped } = coMovedToDiff(moved, "reqwest", 3);
    expect(diff.map((m) => m.name)).toEqual(["http", "hyper", "bytes"]);
    expect(capped.map((m) => m.name)).toEqual(["itoa"]);
  });

  it("names the moved package and its lead in every finding", () => {
    const [f] = coMovedFindings({ name: "http", from: "0.2.12", to: "1.2.0" }, "reqwest", [finding(2)]);
    expect(f?.via).toBe("http 0.2.12 → 1.2.0, moved with reqwest");
    expect(f?.reason).toBe("http 0.2.12 → 1.2.0, moved with reqwest: removed `HeaderMap::get_all`");
  });

  it("says what each move means for the code, and why one wasn't diffed", () => {
    expect(usageCell(usageOf([finding(2), finding(1)]))).toBe("2 breaking changes at 3 sites");
    expect(usageCell(usageOf([]))).toBe("no breaking change it uses");
    expect(usageCell({ diffed: false, breaking: 0, sites: 0, note: "not declared by this repository" })).toBe(
      "not declared by this repository",
    );
    expect(usageCell(undefined)).toBe("not diffed");
  });

  it("attaches usage to the listed packages only", () => {
    const moved = [
      { name: "reqwest", from: "0.11.27", to: "0.12.9" },
      { name: "http", from: "0.2.12", to: "1.2.0" },
    ];
    const out = withUsage(moved, new Map([["http", usageOf([finding(1)])]]));
    expect(out[0]?.yourCode).toBeUndefined();
    expect(out[1]?.yourCode).toEqual({ diffed: true, breaking: 1, sites: 1 });
  });
});
