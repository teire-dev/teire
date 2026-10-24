import { describe, expect, it } from "vitest";
import { jsTargetPolicy, readJsUpgradePolicy } from "../src/inventory/js-policy";
import { memoryTree } from "../src/inventory/tree";
import { BlockedUrlError, guardedFetch, isPrivateAddress } from "../src/net/fetch";
import {
  chooseFixedTarget,
  chooseTarget,
  deprecationChange,
  npmScheme,
  parseDepsDevPackage,
  type TargetPolicy,
} from "../src/registry";
import { fixture } from "./helpers";

const NOW = new Date("2026-10-24T12:00:00Z");
const openai = parseDepsDevPackage(
  "npm",
  "openai",
  fixture("registry/depsdev-npm-openai.json"),
  "https://api.deps.dev/v3/systems/NPM/packages/openai",
  NOW.toISOString(),
);

function policy(overrides: Partial<TargetPolicy> = {}): TargetPolicy {
  return {
    now: NOW,
    minAgeMinutes: () => 7 * 1440,
    pins: [],
    allowPrerelease: false,
    fallbackMajors: 0,
    ...overrides,
  };
}

describe("deps.dev package parsing", () => {
  it("sorts by semver, not the lexical order deps.dev returns", () => {
    const list = openai.versions.map((v) => v.version);
    expect(list.indexOf("7.4.0")).toBeLessThan(list.indexOf("7.40.0"));
    expect(list.indexOf("7.9.0")).toBeLessThan(list.indexOf("7.10.0"));
    expect(openai.defaultVersion).toBe("7.43.0");
    expect(list.at(-1)).toBe("7.43.0");
  });
});

describe("target policy", () => {
  it("takes the newest version outside the cooldown and lists the skipped ones", () => {
    const d = chooseTarget(openai, "4.104.0", policy(), npmScheme);
    expect(d).toMatchObject({ kind: "upgrade", to: "7.36.0", isMajor: true });
    const cooldown = d.skipped.find((s) => s.reason === "cooldown");
    expect(cooldown?.versions[0]).toBe("7.43.0");
    expect(cooldown?.count).toBe(7);
  });

  it("falls back one major at a time after failed verifications", () => {
    expect(chooseTarget(openai, "4.104.0", policy({ fallbackMajors: 1 }), npmScheme)).toMatchObject({
      to: "6.49.0",
    });
    expect(chooseTarget(openai, "4.104.0", policy({ fallbackMajors: 2 }), npmScheme)).toMatchObject({
      to: "5.23.2",
    });
    expect(chooseTarget(openai, "4.104.0", policy({ fallbackMajors: 3 }), npmScheme).kind).toBe("blocked");
  });

  it("honours pins, and stops on a pin to a non-registry source", () => {
    const pinned = chooseTarget(
      openai,
      "4.104.0",
      policy({ pins: [{ value: "^5.0.0", source: "package.json overrides" }] }),
      npmScheme,
    );
    expect(pinned).toMatchObject({ kind: "upgrade", to: "5.23.2" });
    expect(pinned.skipped.find((s) => s.reason === "pinned")?.detail).toContain("package.json overrides");
    const alias = chooseTarget(
      openai,
      "4.104.0",
      policy({ pins: [{ value: "npm:openai-fork@1.0.0", source: "package.json resolutions" }] }),
      npmScheme,
    );
    expect(alias.kind).toBe("blocked");
  });

  it("never proposes pre-releases from a stable version", () => {
    const d = chooseTarget(openai, "4.0.0-beta.11", policy({ allowPrerelease: true }), npmScheme);
    expect(d.kind).toBe("upgrade");
    const stable = chooseTarget(openai, "4.20.0", policy({ minAgeMinutes: () => 0 }), npmScheme);
    expect(stable).toMatchObject({ to: "7.43.0" });
    expect(stable.skipped.some((s) => s.reason === "prerelease")).toBe(true);
  });

  it("takes the smallest fixed version on the advisory's release line, cooldown waived", () => {
    const d = chooseFixedTarget(openai, "4.60.0", ["4.61.0", "5.1.0"], policy(), npmScheme);
    expect(d).toMatchObject({ kind: "upgrade", to: "4.61.0", isMajor: false, cooldownWaived: false });
    const young = chooseFixedTarget(openai, "7.40.0", ["7.42.0"], policy(), npmScheme);
    expect(young).toMatchObject({ to: "7.42.0", cooldownWaived: true });
  });
});

describe("registry deprecations", () => {
  it("quotes the registry's message for a deprecated locked version", () => {
    const request = parseDepsDevPackage(
      "npm",
      "request",
      fixture("registry/depsdev-npm-request.json"),
      "https://api.deps.dev/v3/systems/NPM/packages/request",
      NOW.toISOString(),
    );
    const change = deprecationChange(request, "2.88.2");
    expect(change).toMatchObject({
      kind: "package-deprecated",
      applicability: { class: "notice", affectedRange: "2.88.2" },
      status: "confirmed",
    });
    expect(change?.sources[0]?.quote).toContain("request has been deprecated");
    expect(deprecationChange(openai, "7.43.0")).toBeNull();
  });
});

describe("repo upgrade policy (JS)", () => {
  const tree = memoryTree({
    "package.json": JSON.stringify({
      packageManager: "pnpm@11.2.0",
      overrides: { lodash: "4.17.21", parent: { "left-pad": "1.3.0" }, "semver@<6": "5.7.2" },
      pnpm: { overrides: { "foo>bar": "2.0.0", zod: "$zod" } },
      resolutions: { "**/minimist": "1.2.8", "@s/parent/@s/child": "3.0.0" },
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "minimumReleaseAge: 4320\nminimumReleaseAgeExclude:\n  - openai\n",
    ".npmrc": "min-release-age=10\n",
    ".yarnrc.yml": 'npmMinimalAgeGate: "3d"\nnpmPreapprovedPackages:\n  - "@types/*"\n',
    "bunfig.toml":
      '[install]\nminimumReleaseAge = 259200\nminimumReleaseAgeExcludes = ["typescript@5.4.5"]\n',
  });
  const project = {
    root: ".",
    manager: "pnpm" as const,
    managerVersion: "11.2.0",
    importers: ["."],
    instances: [],
    notes: [],
  };
  const read = readJsUpgradePolicy(tree, project);

  it("reads every package manager's release-age gate in minutes", () => {
    expect(read.gates.map((g) => [g.source, g.minutes])).toEqual([
      ["pnpm-workspace.yaml minimumReleaseAge", 4320],
      [".npmrc min-release-age", 14_400],
      [".yarnrc.yml npmMinimalAgeGate", 4320],
      ["bunfig.toml install.minimumReleaseAge", 4320],
    ]);
  });

  it("reads overrides and resolutions with selectors and parents", () => {
    const byName = Object.fromEntries(read.pins.map((p) => [`${p.parent ?? ""}>${p.name}`, p]));
    expect(byName[">lodash"]).toMatchObject({ value: "4.17.21", source: "package.json overrides" });
    expect(byName["parent>left-pad"]).toMatchObject({ value: "1.3.0" });
    expect(byName[">semver"]).toMatchObject({ selector: "<6" });
    expect(byName["foo>bar"]).toMatchObject({ value: "2.0.0" });
    expect(byName[">minimist"]).toMatchObject({ value: "1.2.8" });
    expect(byName["@s/parent>@s/child"]).toMatchObject({ value: "3.0.0" });
  });

  it("applies the strictest gate unless the package is exempt", () => {
    const openaiPolicy = jsTargetPolicy(read, "openai", "4.104.0", { now: NOW });
    // pnpm exempts openai; .npmrc's 10 days still applies.
    expect(openaiPolicy.minAgeMinutes("7.43.0")).toBe(14_400);
    const ts = jsTargetPolicy(read, "typescript", "5.4.0", { cooldownDays: 0 });
    expect(ts.minAgeMinutes("5.4.5")).toBe(14_400);
    expect(jsTargetPolicy(read, "lodash", "4.17.20").pins).toEqual([
      { value: "4.17.21", source: "package.json overrides" },
    ]);
    expect(jsTargetPolicy(read, "semver", "7.6.0").pins).toEqual([]);
    expect(jsTargetPolicy(read, "zod", "3.0.0").pins).toEqual([]);
  });
});

describe("guarded fetch", () => {
  it("knows private and local ranges", () => {
    for (const a of [
      "10.1.2.3",
      "127.0.0.1",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
    ])
      expect(isPrivateAddress(a)).toBe(true);
    for (const a of ["104.16.0.1", "8.8.8.8", "2606:4700::1111"]) expect(isPrivateAddress(a)).toBe(false);
  });

  it("refuses plain http, local hosts and hosts outside the allowlist before any request", async () => {
    await expect(guardedFetch("http://registry.npmjs.org/openai")).rejects.toThrow(BlockedUrlError);
    await expect(guardedFetch("https://127.0.0.1/")).rejects.toThrow(BlockedUrlError);
    await expect(guardedFetch("https://localhost/")).rejects.toThrow(BlockedUrlError);
    await expect(guardedFetch("https://example.com/", { allowHosts: ["api.deps.dev"] })).rejects.toThrow(
      BlockedUrlError,
    );
  });
});
