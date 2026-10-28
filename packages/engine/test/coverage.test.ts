import { describe, expect, it } from "vitest";
import { advisoryStatus, coverageLines, lookupsAnswered, newScanCoverage } from "../src/pipeline/coverage";

describe("scan coverage (D96)", () => {
  it("says an advisory outage is unknown, never 'no advisories'", () => {
    const c = newScanCoverage();
    c.advisories.push({ ecosystem: "npm", root: ".", status: "unavailable", notes: ["OSV: fetch failed"] });
    expect(advisoryStatus(c)).toBe("unavailable");
    expect(coverageLines(c).join("\n")).toContain('This is not the same as "no advisories"');
    expect(lookupsAnswered(c)).toBe(false);
  });

  it("names failed version lookups as unknown, not up to date", () => {
    const c = newScanCoverage();
    c.lookupsFailed.push({ ecosystem: "pypi", name: "pydantic" });
    expect(coverageLines(c).join("\n")).toContain('newer versions are unknown, not "up to date"');
    expect(lookupsAnswered(c)).toBe(false);
  });

  it("keeps Maven's structural gap partial without blocking the retirement of findings", () => {
    const c = newScanCoverage();
    c.advisories.push({
      ecosystem: "maven",
      root: ".",
      status: "partial",
      structural: true,
      notes: ["Maven: …"],
    });
    c.advisories.push({ ecosystem: "npm", root: ".", status: "complete", notes: [] });
    expect(advisoryStatus(c)).toBe("partial");
    expect(lookupsAnswered(c)).toBe(true);
  });
});
