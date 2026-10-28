import { describe, expect, it } from "vitest";
import { globMatcher } from "../src/inventory/tree";

describe("teire.yml paths globs", () => {
  it("a trailing ** takes everything beneath the folder", () => {
    const m = globMatcher(["web/**"]);
    expect(m("web/package.json")).toBe(true);
    expect(m("web/src/a/b.ts")).toBe(true);
    expect(m("api/web/x")).toBe(false);
  });

  it("**/ spans any number of folders, and a bare folder is a prefix", () => {
    const m = globMatcher(["src/**/*.ts", "docs"]);
    expect(m("src/y.ts")).toBe(true);
    expect(m("src/a/b/y.ts")).toBe(true);
    expect(m("src/a/y.js")).toBe(false);
    expect(m("docs/guide/a.md")).toBe(true);
  });
});
