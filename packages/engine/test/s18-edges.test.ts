import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { goTransaction } from "../src/fix/upgrade-go";
import { readGoInventory } from "../src/inventory/go";
import { evalGemfiles, gemspecDependencies, readRubyInventory } from "../src/inventory/ruby";
import { cargoPatches, readRustInventory } from "../src/inventory/rust";
import { directoryTree, memoryTree } from "../src/inventory/tree";
import { coverageLines, newScanCoverage, outcomesOf } from "../src/pipeline/coverage";

describe("Cargo [patch], [replace] and MSRV policy (S18.4)", () => {
  it("reports a patched crate as what builds, and reads Cargo's MSRV policy", () => {
    expect(
      cargoPatches({
        patch: {
          "crates-io": {
            serde: { git: "https://github.com/serde-rs/serde", rev: "abc" },
            foo: { path: "../foo" },
          },
        },
        replace: { "bar:0.1.0": { path: "vendor/bar" } },
      }),
    ).toEqual(
      new Map([
        ["serde", "[patch] git https://github.com/serde-rs/serde@abc"],
        ["foo", "[patch] path ../foo"],
        ["bar", "[replace] path vendor/bar"],
      ]),
    );
    const [project] = readRustInventory(
      memoryTree({
        "Cargo.toml":
          '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2024"\nrust-version = "1.80"\n\n[dependencies]\nserde = "1"\ntokio = "1"\n\n[patch.crates-io]\nserde = { path = "../serde" }\n',
      }),
    );
    expect(project?.msrvPolicy).toBe("fallback");
    expect(project?.instances.find((i) => i.name === "serde")).toMatchObject({
      source: "path",
      sourceRef: "[patch] path ../serde",
    });
    expect(project?.instances.find((i) => i.name === "tokio")?.source).toBe("registry");
  });
});

describe("Ruby eval_gemfile and gemspec dependencies (S18.4)", () => {
  it("follows eval_gemfile and reads a gemspec's own dependencies as direct", () => {
    expect(
      evalGemfiles(
        'eval_gemfile "Gemfile.common"\neval_gemfile File.expand_path("gemfiles/ci.rb", __dir__)\n',
      ),
    ).toEqual(["Gemfile.common", "gemfiles/ci.rb"]);
    expect(
      gemspecDependencies(
        'spec.add_dependency "rack", ">= 2.2", "< 4"\nspec.add_runtime_dependency("concurrent-ruby", "~> 1.1")\nspec.add_development_dependency "rspec"\n',
      ),
    ).toEqual([
      { name: "rack", requirement: ">= 2.2, < 4", development: false },
      { name: "concurrent-ruby", requirement: "~> 1.1", development: false },
      { name: "rspec", development: true },
    ]);
    const [project] = readRubyInventory(
      memoryTree({
        Gemfile: 'source "https://rubygems.org"\ngemspec\neval_gemfile "Gemfile.tools"\n',
        "Gemfile.tools": 'gem "rubocop", "~> 1.60", group: :development\n',
        "mygem.gemspec": 'Gem::Specification.new do |spec|\n  spec.add_dependency "rack", ">= 2.2"\nend\n',
      }),
    );
    expect(project?.instances.find((i) => i.name === "rubocop")).toMatchObject({
      manifestPath: "Gemfile.tools",
      declaredRange: "~> 1.60",
    });
    expect(project?.instances.find((i) => i.name === "rack")).toMatchObject({
      manifestPath: "mygem.gemspec",
      scope: "prod",
      declaredRange: ">= 2.2",
    });
  });
});

describe("Go workspaces (S18.4)", () => {
  const dir = mkdtempSync(join(tmpdir(), "teire-go-work-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };

  it("takes the workspace's selection and re-vendors at the workspace", async () => {
    write("go.work", "go 1.22\n\nuse (\n\t./api\n\t./worker\n)\n");
    write("api/go.mod", "module example.com/api\n\ngo 1.22\n\nrequire github.com/google/uuid v1.5.0\n");
    write("worker/go.mod", "module example.com/worker\n\ngo 1.22\n\nrequire github.com/google/uuid v1.6.0\n");
    write("vendor/modules.txt", "# github.com/google/uuid v1.6.0\n");
    const projects = await readGoInventory(dir, directoryTree(dir));
    const api = projects.find((p) => p.root === "api");
    // MVS over the workspace: api builds with the worker's newer uuid.
    expect(api?.instances.find((i) => i.name === "github.com/google/uuid")).toMatchObject({
      version: "v1.6.0",
      resolvedBy: "toolchain",
    });
    expect(api?.work).toEqual({ file: "go.work", root: ".", vendored: true });
    const instance = api?.instances[0];
    if (!api || !instance) throw new Error("no api");
    const tx = goTransaction(directoryTree(dir), api, instance, instance.name, "v1.6.1");
    expect(tx.commands.at(-1)?.join(" ")).toContain('GOWORK="$PWD/../go.work"');
    expect(tx.commands[0]?.slice(0, 2)).toEqual(["env", "GOWORK=off"]);
  }, 120_000);
});

describe("what a scan didn't compare or held, said (S18.4)", () => {
  it("lists each direct dependency left out and each held upgrade with its reason", () => {
    const coverage = newScanCoverage();
    const base = {
      direct: true,
      scope: "prod",
      workspace: ".",
      manifestPath: "Gemfile",
      resolvedBy: "unresolved",
    } as const;
    outcomesOf(
      [
        {
          instances: [
            {
              ...base,
              ecosystem: "rubygems",
              name: "rails",
              version: null,
              source: "git",
              sourceRef: "https://github.com/rails/rails",
            },
            { ...base, ecosystem: "rubygems", name: "mygem", version: null, source: "workspace" },
            {
              ...base,
              ecosystem: "npm",
              name: "express",
              version: "4.18.1",
              source: "registry",
              resolvedBy: "lockfile",
            },
          ],
        },
      ],
      [
        {
          instance: {
            ...base,
            ecosystem: "npm",
            name: "express",
            version: "4.18.1",
            source: "registry",
            resolvedBy: "lockfile",
          },
          decision: {
            kind: "blocked",
            from: "4.18.1",
            reason: "express is patched by patches/x.patch",
            skipped: [],
          },
        },
      ],
      coverage,
    );
    const lines = coverageLines(coverage);
    expect(
      lines.some((l) =>
        l.includes(
          "`rails` (a git source: Teire compares registry versions (https://github.com/rails/rails))",
        ),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.includes("mygem"))).toBe(false);
    expect(lines.some((l) => l.startsWith("1 upgrade is held: `express` (express is patched"))).toBe(true);
  });
});
