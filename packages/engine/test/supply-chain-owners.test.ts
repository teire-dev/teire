import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { memoryCache } from "../src/registry/types";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", "supply-chain", name), "utf8");

// Recorded registry responses (2026-10-30), served by URL; anything else is a 404.
const recorded: Record<string, () => string> = {
  "https://pypi.org/pypi/requests/json": () => fixture("pypi-requests-ownership.json"),
  "https://rubygems.org/api/v1/gems/rack/owners.json": () => fixture("rubygems-rack-owners.json"),
  "https://crates.io/api/v1/crates/serde/1.0.215": () => fixture("crates-serde-1.0.215.json"),
  "https://crates.io/api/v1/crates/serde/1.0.214": () =>
    fixture("crates-serde-1.0.215.json").replace('"dtolnay"', '"another-account"'),
  "https://pypi.org/integrity/urllib3/2.3.0/urllib3-2.3.0-py3-none-any.whl/provenance": () =>
    fixture("pypi-urllib3-2.3.0-provenance.json"),
};

vi.mock("../src/net/fetch", () => ({
  guardedFetch: async (url: string) => {
    const body = recorded[url]?.();
    const bytes = new TextEncoder().encode(body ?? "");
    return {
      status: body === undefined ? 404 : 200,
      url,
      finalUrl: url,
      redirects: [],
      headers: new Headers(),
      body: bytes,
      text: () => body ?? "",
      json: () => JSON.parse(body ?? "null"),
    };
  },
}));

const { crateSignals, ownerChange, packageOwners, pypiPublisher, snapshotOwners } = await import(
  "../src/registry/supply-chain"
);

describe("owners and publishers, from recorded registry responses (R21.6)", () => {
  it("reads today's owners from PyPI's ownership and RubyGems' owners.json", async () => {
    expect(await packageOwners("pypi", "requests")).toEqual(["Lukasa", "graffatcolmingov", "nateprewitt"]);
    const rack = await packageOwners("rubygems", "rack");
    expect(rack).toContain("chneukirchen");
    expect(rack?.length).toBe(6);
    expect(await packageOwners("pypi", "no-such-project")).toBeNull();
  });

  it("compares today's owners with the snapshot from when the installed version was first seen", async () => {
    const options = { cache: memoryCache(), now: new Date("2026-10-01T00:00:00Z") };
    expect(await ownerChange("pypi", "requests", "2.31.0", options)).toBeNull();
    // The first scan's snapshot, as the owners stood then.
    await options.cache.put("pypi", "owners:requests@2.31.0", {
      etag: null,
      lastModified: null,
      bodyHash: "",
      data: ["Lukasa", "graffatcolmingov", "kennethreitz"],
      fetchedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(await ownerChange("pypi", "requests", "2.31.0", options)).toBe(
      "requests's owners changed since 2026-09-01, when Teire first saw 2.31.0 here: added `nateprewitt`; removed `kennethreitz`",
    );
    // A snapshot is kept once per version, never overwritten.
    await snapshotOwners("pypi", "requests", "2.31.0", options);
    expect((await options.cache.get("pypi", "owners:requests@2.31.0"))?.data).toContain("kennethreitz");
    await snapshotOwners("pypi", "requests", "2.32.3", options);
    expect(await ownerChange("pypi", "requests", "2.32.3", options)).toBeNull();
  });

  it("reads a crate version's publisher and a wheel's PEP 740 publisher", async () => {
    expect(await crateSignals("serde", "1.0.214", "1.0.215")).toEqual([
      "1.0.215 was published by the crates.io account `dtolnay`; 1.0.214 by `another-account`",
    ]);
    expect(await pypiPublisher("urllib3", "2.3.0", "urllib3-2.3.0-py3-none-any.whl")).toBe(
      "GitHub urllib3/urllib3 publish.yml",
    );
  });
});
