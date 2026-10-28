import { describe, expect, it } from "vitest";
import { memoryTree } from "../src/inventory/tree";
import { nodeEnv, nodeFor, pythonFor, rustFor } from "../src/verify/toolchains";

describe("toolchain versions from the repo", () => {
  it("reads Node from .nvmrc (versions and lts codenames), volta and engines", () => {
    expect(nodeFor(memoryTree({ ".nvmrc": "v20.11.1\n" }), ".")).toMatchObject({
      version: "20",
      source: ".nvmrc",
    });
    expect(nodeFor(memoryTree({ ".nvmrc": "lts/hydrogen" }), ".")?.version).toBe("18");
    expect(nodeFor(memoryTree({ ".nvmrc": "14" }), ".")).toMatchObject({ version: "18" });
    expect(nodeFor(memoryTree({ ".nvmrc": "14" }), ".")?.note).toContain("Node 14");
    expect(
      nodeFor(memoryTree({ "package.json": JSON.stringify({ engines: { node: ">=18 <23" } }) }), ".")
        ?.version,
    ).toBe("22");
    expect(nodeFor(memoryTree({ "package.json": "{}" }), ".")).toBeNull();
    expect(nodeEnv({ version: "20", source: ".nvmrc" }).PATH).toMatch(/^\/opt\/node\/20\/bin:/);
    expect(nodeEnv({ version: "24", source: ".nvmrc" })).toEqual({});
  });

  it("reads Python from .python-version and requires-python, Poetry ranges included", () => {
    expect(pythonFor(memoryTree({ ".python-version": "3.11.9" }), ".")?.version).toBe("3.11");
    expect(
      pythonFor(memoryTree({ "pyproject.toml": '[project]\nrequires-python = ">=3.8,<3.12"\n' }), ".")
        ?.version,
    ).toBe("3.11");
    expect(
      pythonFor(memoryTree({ "pyproject.toml": '[tool.poetry.dependencies]\npython = "^3.10"\n' }), ".")
        ?.version,
    ).toBe("3.13");
  });

  it("reads a rust-toolchain channel", () => {
    expect(
      rustFor(memoryTree({ "rust-toolchain.toml": '[toolchain]\nchannel = "1.75.0"\n' }), ".")?.version,
    ).toBe("1.75.0");
    expect(rustFor(memoryTree({ "rust-toolchain": "stable\n" }), ".")?.version).toBe("stable");
    expect(rustFor(memoryTree({}), ".")).toBeNull();
  });
});
