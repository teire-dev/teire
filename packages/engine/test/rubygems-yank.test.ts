import { describe, expect, it } from "vitest";
import { rubygemsYankChange } from "../src/registry/deprecation";

describe("a yanked gem (D76)", () => {
  it("is a locked version missing from the version list that loaded", () => {
    expect(rubygemsYankChange("nokogiri", "1.16.3", ["1.16.2", "1.16.4", "1.16.4"])).toMatchObject({
      kind: "package-yanked",
      applicability: { class: "already-broken", affectedRange: "1.16.3" },
    });
    expect(rubygemsYankChange("nokogiri", "1.16.4", ["1.16.2", "1.16.4"])).toBeNull();
    // A failed lookup is no evidence.
    expect(rubygemsYankChange("nokogiri", "1.16.3", [])).toBeNull();
  });
});
