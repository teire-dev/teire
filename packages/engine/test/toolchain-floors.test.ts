import { describe, expect, it } from "vitest";
import { withToolchainFloors } from "../src/fix/toolchain-floors";
import { memoryTree } from "../src/inventory/tree";
import { memoryCache } from "../src/registry";

// S15.10, review R3: the toolchain a target needs is raised in the same change.
describe("toolchain floors", () => {
  it("raises requires-python to the target's own floor, inside the updater's edit", async () => {
    const cache = memoryCache();
    await cache.put("pypi", "version:pydantic@2.14.1", {
      etag: null,
      lastModified: null,
      bodyHash: "",
      data: { projectUrls: {}, requiresDist: [], requiresPython: ">=3.10", yanked: null },
      fetchedAt: new Date().toISOString(),
    });
    const pyproject =
      '[project]\nname = "app"\nrequires-python = ">=3.8,<4"\ndependencies = ["pydantic>=1.10"]\n';
    const updated = pyproject.replace("pydantic>=1.10", "pydantic>=2.14.1");
    const { edits } = await withToolchainFloors({
      ecosystem: "pypi",
      tree: memoryTree({ "pyproject.toml": pyproject }),
      project: { root: ".", manager: "uv" },
      name: "pydantic",
      target: "2.14.1",
      edits: [{ path: "pyproject.toml", before: pyproject, after: updated, from: "1.10", to: "2.14.1" }],
      options: { cache } as never,
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.after).toContain('requires-python = ">=3.10,<4"');
    expect(edits[0]?.after).toContain("pydantic>=2.14.1");
    expect(edits[0]?.note).toContain("3.8 → 3.10");
  });

  it("leaves a project already at the floor alone", async () => {
    const cache = memoryCache();
    await cache.put("pypi", "version:httpx@0.28.1", {
      etag: null,
      lastModified: null,
      bodyHash: "",
      data: { projectUrls: {}, requiresDist: [], requiresPython: ">=3.8", yanked: null },
      fetchedAt: new Date().toISOString(),
    });
    const pyproject = '[project]\nrequires-python = ">=3.11"\n';
    const { edits } = await withToolchainFloors({
      ecosystem: "pypi",
      tree: memoryTree({ "pyproject.toml": pyproject }),
      project: { root: ".", manager: "uv" },
      name: "httpx",
      target: "0.28.1",
      edits: [],
      options: { cache } as never,
    });
    expect(edits).toEqual([]);
  });
});
