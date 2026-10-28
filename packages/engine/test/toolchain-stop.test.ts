import { describe, expect, it } from "vitest";
import { memoryTree } from "../src/inventory/tree";
import { unsupportedToolchain } from "../src/verify";

describe("runtimes the sandbox can't fall forward from (S14.2)", () => {
  it("stops on Python 2 and on a requires-python no sandbox Python meets", () => {
    expect(unsupportedToolchain(memoryTree({ ".python-version": "2.7.18\n" }), ".", "pypi")?.asks).toBe(
      "Python 2.7.18",
    );
    const py = memoryTree({ "pyproject.toml": '[project]\nrequires-python = "<3.9"\n' });
    expect(unsupportedToolchain(py, ".", "pypi")?.file).toBe("pyproject.toml");
    expect(unsupportedToolchain(memoryTree({ ".python-version": "3.8" }), ".", "pypi")).toBeNull();
  });

  it("stops on an exact Ruby below 3.2, not on a CI preference", () => {
    expect(
      unsupportedToolchain(
        memoryTree({ Gemfile: 'source "https://rubygems.org"\nruby "2.7.8"\n' }),
        ".",
        "rubygems",
      )?.asks,
    ).toBe("Ruby 2.7.8");
    expect(
      unsupportedToolchain(memoryTree({ ".travis.yml": "rvm:\n  - 2.7\n" }), ".", "rubygems"),
    ).toBeNull();
    expect(unsupportedToolchain(memoryTree({ ".ruby-version": "3.3.6" }), ".", "rubygems")).toBeNull();
  });

  it("stops on Node only when engine-strict refuses every sandbox major", () => {
    const pkg = JSON.stringify({ engines: { node: ">=12 <15" } });
    expect(
      unsupportedToolchain(memoryTree({ "package.json": pkg, ".npmrc": "engine-strict=true\n" }), ".", "npm")
        ?.file,
    ).toContain("engine-strict");
    expect(unsupportedToolchain(memoryTree({ "package.json": pkg }), ".", "npm")).toBeNull();
  });
});
