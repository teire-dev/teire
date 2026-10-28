import { describe, expect, it } from "vitest";
import { describeFixMode, effectiveFixMode, personMayStart, startsOnItsOwn } from "../src/config";

const file = (fixes: "automatic" | "ask" | "off" | null, origin: "repo" | "org" = "repo") => ({
  fixes,
  securityFixes: null,
  origins: fixes ? { fixes: origin } : {},
  path: origin === "repo" ? ".github/teire.yml" : null,
});

// Plan revision 3.3, D124: the repo file, then the dashboard, then the org file, then the installation.
describe("effectiveFixMode", () => {
  it("the repository's file wins over the dashboard", () => {
    const m = effectiveFixMode({ config: file("off"), repoOverride: "auto", installationDefault: "auto" });
    expect([m.mode, m.origin]).toEqual(["off", "repo-file"]);
    expect(describeFixMode(m)).toBe("Off (set in .github/teire.yml)");
    expect(personMayStart(m)).toBe(false);
  });

  it("the dashboard wins over the org file and the installation", () => {
    const m = effectiveFixMode({
      config: file("off", "org"),
      repoOverride: "ask",
      installationDefault: "off",
    });
    expect([m.mode, m.origin]).toEqual(["ask", "dashboard"]);
  });

  it("then the org file, then the installation, then automatic", () => {
    expect(
      effectiveFixMode({ config: file("ask", "org"), repoOverride: null, installationDefault: "off" }).origin,
    ).toBe("org-file");
    expect(
      effectiveFixMode({ config: file(null), repoOverride: null, installationDefault: "off" }).mode,
    ).toBe("off");
    expect(effectiveFixMode({ config: null, repoOverride: null, installationDefault: null }).mode).toBe(
      "auto",
    );
  });

  it("ask first starts nothing on its own; security follows its own setting unless fixes are off", () => {
    const ask = effectiveFixMode({ config: null, repoOverride: "ask", installationDefault: null });
    expect(startsOnItsOwn(ask, false)).toBe(false);
    expect(startsOnItsOwn(ask, true)).toBe(true);
    expect(personMayStart(ask)).toBe(true);
    const off = effectiveFixMode({ config: null, repoOverride: "off", installationDefault: null });
    expect(startsOnItsOwn(off, true)).toBe(false);
    const askSecurity = effectiveFixMode({
      config: null,
      repoOverride: null,
      installationDefault: null,
      installationSecurity: "ask",
    });
    expect(startsOnItsOwn(askSecurity, true)).toBe(false);
  });
});
