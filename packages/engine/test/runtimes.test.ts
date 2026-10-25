import { describe, expect, it } from "vitest";
import { readJsInventory } from "../src/inventory/js";
import { memoryTree } from "../src/inventory/tree";
import { assessRuntimes, runtimesOf } from "../src/pipeline/runtimes";
import { memoryCache } from "../src/registry";

const NODE = {
  result: {
    name: "nodejs",
    label: "Node.js",
    releases: [
      { name: "24", label: "24", isLts: true, eolFrom: "2028-04-30", isMaintained: true },
      { name: "22", label: "22", isLts: true, eolFrom: "2027-04-30", isMaintained: true },
      { name: "18", label: "18", isLts: true, eolFrom: "2025-04-30", isMaintained: false },
    ],
  },
};

describe("runtime end of life", () => {
  it("points at engines.node in package.json, not the package's own version line", () => {
    const tree = memoryTree({
      "package.json": '{\n  "name": "x",\n  "version": "1.0.0",\n  "engines": { "node": ">=20" }\n}\n',
      "package-lock.json": JSON.stringify({ name: "x", lockfileVersion: 3, packages: { "": { name: "x" } } }),
    });
    const [use] = runtimesOf(tree, readJsInventory(tree), []);
    expect(use).toMatchObject({ runtime: "node", line: "20", file: "package.json", lineNo: 4 });
  });


  it("reads the runtime the repo runs and flags a line past its end of life", async () => {
    const tree = memoryTree({
      "package.json": JSON.stringify({ name: "x", engines: { node: ">=16" } }),
      ".nvmrc": "18\n",
      "package-lock.json": JSON.stringify({ name: "x", lockfileVersion: 3, packages: { "": { name: "x" } } }),
    });
    const uses = runtimesOf(tree, readJsInventory(tree), []);
    expect(uses).toEqual([{ runtime: "node", line: "18", file: ".nvmrc", lineNo: 1, snippet: "18" }]);
    const cache = memoryCache();
    await cache.put("endoflife", "nodejs", {
      etag: null,
      lastModified: null,
      bodyHash: "",
      fetchedAt: new Date().toISOString(),
      data: {
        product: "nodejs",
        label: "Node.js",
        releases: NODE.result.releases.map((r) => ({
          line: r.name,
          label: r.label,
          releasedOn: null,
          lts: r.isLts,
          activeSupportUntil: null,
          eolOn: r.eolFrom,
          maintained: r.isMaintained,
          latest: null,
        })),
        source: {
          url: "https://endoflife.date/api/v1/products/nodejs/",
          checkedAt: new Date().toISOString(),
        },
      },
    });
    const { findings, records } = await assessRuntimes(uses, {
      cache,
      now: new Date("2026-10-25T00:00:00Z"),
    });
    expect(records[0]?.title).toBe("Node.js 18 reached end of life on 2025-04-30");
    expect(findings[0]?.class).toBe("notice");
    expect(findings[0]?.position).toEqual({ version: "Node.js 18", target: "Node.js 24", isMajor: false });
    expect(findings[0]?.callSites[0]?.file).toBe(".nvmrc");
  });
});
