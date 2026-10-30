import { describe, expect, it } from "vitest";
import { wideningsOf } from "../src/fix/review";

const patch = (file: string, removed: string[], added: string[]) =>
  [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,3 +1,3 @@",
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");

describe("Teire's own widening check of a fix", () => {
  it("flags the zod 4 fix that widened a record's values to unknown", () => {
    const found = wideningsOf(
      patch(
        "npm-zod/src/schema.ts",
        ["    labels: z.record(z.string()).default({}),"],
        ["    labels: z.record(z.string(), z.unknown()).default({}),"],
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe("npm-zod/src/schema.ts");
    expect(found[0]?.problem).toContain("z.unknown()");
    expect(found[0]?.problem).toContain("accepts any value");
  });

  it("leaves a narrow migration alone, and a widening that was already there", () => {
    expect(
      wideningsOf(
        patch("a.ts", ["labels: z.record(z.string())"], ["labels: z.record(z.string(), z.string())"]),
      ),
    ).toEqual([]);
    expect(wideningsOf(patch("a.ts", ["x: z.unknown(),"], ["y: z.unknown(),"]))).toEqual([]);
  });

  it("catches silenced checks and skipped tests in other languages", () => {
    expect(
      wideningsOf(
        patch(
          "app/llm.py",
          ["resp = client.create(model=m)"],
          ["resp = client.create(model=m)  # type: ignore"],
        ),
      ),
    ).toHaveLength(1);
    expect(
      wideningsOf(
        patch(
          "auth/token_test.go",
          ["func TestExpiry(t *testing.T) {"],
          ["func TestExpiry(t *testing.T) {", "\tt.Skip()"],
        ),
      ),
    ).toHaveLength(1);
    expect(
      wideningsOf(patch("src/lib.rs", ["fn a() {}"], ["#[allow(deprecated)]", "fn a() {}"])),
    ).toHaveLength(1);
    // A word in prose is not a type.
    expect(wideningsOf(patch("README.md", ["any"], ["any any"]))).toEqual([]);
  });
});
