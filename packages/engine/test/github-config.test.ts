import { describe, expect, it } from "vitest";
import { readTeireConfig } from "../src/config";
import { DEFAULT_CONFIG } from "../src/github";
import { memoryTree } from "../src/inventory/tree";

describe("the onboarding PR's teire.yml", () => {
  it("passes Teire's own validation, so merging it never fails the config check", () => {
    const config = readTeireConfig(memoryTree({ ".github/teire.yml": DEFAULT_CONFIG }));
    expect(config.present).toBe(true);
    expect(config.issues).toEqual([]);
    expect(config.problems).toEqual([]);
  });
});
