import { describe, expect, it } from "vitest";
import { GO_PSEUDO, retractionOf, retractionsFromEditJson } from "../src/registry/go";

// The shape `go mod edit -json` prints for a go.mod with a single, a range and a block of retractions.
const EDIT_JSON = JSON.stringify({
  Module: { Path: "example.com/lib" },
  Retract: [
    { Low: "v1.0.0", High: "v1.0.0", Rationale: "Published accidentally." },
    { Low: "v1.1.0", High: "v1.1.5", Rationale: "  Data race in the pool; fixed in v1.1.6.\n" },
    { Low: "v2.0.0-beta.1", High: "v2.0.0-beta.1" },
  ],
});

describe("Go retractions (D-40)", () => {
  const ranges = retractionsFromEditJson(EDIT_JSON);

  it("reads Go's own parse of every retract form, with the authors' reason", () => {
    expect(ranges).toEqual([
      { low: "v1.0.0", high: "v1.0.0", rationale: "Published accidentally." },
      { low: "v1.1.0", high: "v1.1.5", rationale: "Data race in the pool; fixed in v1.1.6." },
      { low: "v2.0.0-beta.1", high: "v2.0.0-beta.1", rationale: null },
    ]);
  });

  it("covers a version inclusively at both ends of a range, and nothing outside", () => {
    expect(retractionOf("v1.1.0", ranges)?.rationale).toContain("Data race");
    expect(retractionOf("v1.1.5", ranges)?.rationale).toContain("Data race");
    expect(retractionOf("v1.1.3", ranges)).not.toBeNull();
    expect(retractionOf("v1.1.6", ranges)).toBeNull();
    expect(retractionOf("v1.0.1", ranges)).toBeNull();
    expect(retractionOf("v2.0.0-beta.1", ranges)?.rationale).toBeNull();
  });

  it("reads a go.mod with no retractions as none", () => {
    expect(retractionsFromEditJson(JSON.stringify({ Module: { Path: "x" } }))).toEqual([]);
  });

  it("tells a pseudo-version (a commit) from a release", () => {
    for (const v of [
      "v0.0.0-20220906165146-f3363e06e74c",
      "v1.2.4-0.20230101000000-abcdef123456",
      "v1.2.3-pre.0.20230101000000-abcdef123456",
    ])
      expect(GO_PSEUDO.test(v), v).toBe(true);
    for (const v of ["v1.2.3", "v1.2.3-rc.1", "v0.0.0", "v1.2.3-20220906"])
      expect(GO_PSEUDO.test(v), v).toBe(false);
  });
});
