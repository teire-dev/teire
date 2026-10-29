import { describe, expect, it } from "vitest";
import { setConfigKey } from "../src/config/edit";

describe("setConfigKey (config PRs from the dashboard)", () => {
  const file = "# Teire's settings\nfixes: automatic # the default\npullRequests:\n  limit: 5\n";

  it("sets a key and keeps the file's comments", () => {
    const out = setConfigKey(file, "fixes", "ask");
    expect(out).toMatchObject({ changed: true });
    if ("text" in out) {
      expect(out.text).toContain("# Teire's settings");
      expect(out.text).toContain("fixes: ask");
      expect(out.text).toContain("limit: 5");
    }
    const nested = setConfigKey(file, "pullRequests.perHour", "3");
    expect("text" in nested && nested.text).toContain("perHour: 3");
  });

  it("refuses a value the key doesn't take, and says nothing changed for the same value", () => {
    expect(setConfigKey(file, "fixes", "sometimes")).toMatchObject({
      error: expect.stringContaining("automatic, ask, off"),
    });
    expect(setConfigKey(file, "pullRequests.limit", "500")).toMatchObject({
      error: expect.stringContaining("0 to 50"),
    });
    expect(setConfigKey(file, "pullRequests.limit", "5")).toMatchObject({ changed: false });
    // A parent that isn't a mapping is a refusal, not a crash.
    expect(setConfigKey("upgrades: true\n", "upgrades.majors", "false")).toMatchObject({
      error: expect.any(String),
    });
  });

  it("sets a list from lines or commas, deduplicated, and knows when it's the same", () => {
    const out = setConfigKey(file, "ignore", "openai\nnpm:zod, openai");
    expect(out).toMatchObject({ changed: true });
    if ("text" in out) {
      expect(out.text).toMatch(/ignore:\n\s+- openai\n\s+- npm:zod/);
      expect(setConfigKey(out.text, "ignore", "openai, npm:zod")).toMatchObject({ changed: false });
    }
  });
});
