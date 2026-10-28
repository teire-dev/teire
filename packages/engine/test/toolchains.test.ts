import { describe, expect, it } from "vitest";
import { memoryTree } from "../src/inventory/tree";
import { nodeEnv, nodeFor, pythonFor, rubyFor, rustFor } from "../src/verify/toolchains";

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

  it("prefers the Python the repo's CI sets up over a pyproject range", () => {
    const poetry = '[tool.poetry.dependencies]\npython = "^3.8"\n';
    const step = (version: string) =>
      `jobs:\n  test:\n    steps:\n      - uses: actions/setup-python@v4\n        with:\n          python-version: ${version}\n`;
    const single = pythonFor(
      memoryTree({ "pyproject.toml": poetry, ".github/workflows/ci.yml": step('"3.8"') }),
      ".",
    );
    expect(single).toMatchObject({ version: "3.10", source: "CI setup-python" });
    expect(single?.note).toContain("CI runs Python 3.8");
    const matrix = `jobs:\n  test:\n    strategy:\n      matrix:\n        python-version: ["3.9", "3.11"]\n    steps:\n      - uses: actions/setup-python@v5\n        with:\n          python-version: \${{ matrix.python-version }}\n`;
    expect(
      pythonFor(memoryTree({ "pyproject.toml": poetry, ".github/workflows/ci.yml": matrix }), ".")?.version,
    ).toBe("3.11");
  });

  it("prefers the Ruby the repo's CI tests on, as the nearest provided one", () => {
    // coal: Travis on 2.6.5 and 2.7.2, no pin; its spec matches Ruby < 3.4's NoMethodError message.
    expect(
      rubyFor(memoryTree({ ".travis.yml": "language: ruby\nrvm:\n  - 2.6.5\n  - 2.7.2\n" }), "."),
    ).toMatchObject({
      version: "3.2.11",
      source: ".travis.yml",
    });
    const matrix = `jobs:\n  test:\n    strategy:\n      matrix:\n        ruby: ["3.2", "3.3"]\n    steps:\n      - uses: ruby/setup-ruby@v1\n        with:\n          ruby-version: \${{ matrix.ruby }}\n`;
    expect(rubyFor(memoryTree({ ".github/workflows/ci.yml": matrix }), ".")?.version).toBe("3.3.13");
    expect(rubyFor(memoryTree({}), ".")).toBeNull();
  });

  it("reads a rust-toolchain channel", () => {
    expect(
      rustFor(memoryTree({ "rust-toolchain.toml": '[toolchain]\nchannel = "1.75.0"\n' }), ".")?.version,
    ).toBe("1.75.0");
    expect(rustFor(memoryTree({ "rust-toolchain": "stable\n" }), ".")?.version).toBe("stable");
    expect(rustFor(memoryTree({}), ".")).toBeNull();
  });
});
