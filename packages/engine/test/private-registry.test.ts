import { describe, expect, it } from "vitest";
import type { RepoTree } from "../src/inventory/tree";
import { privateRegistry } from "../src/verify/private-registry";

const tree = (files: Record<string, string>): RepoTree => ({
  files: () => Object.keys(files),
  read: (p) => files[p] ?? null,
});

describe("a root that installs from a private registry is never cached (R21.11)", () => {
  it("reads npm's config above the root and the lockfile's resolved hosts", () => {
    expect(
      privateRegistry(
        tree({
          "app/package-lock.json":
            '"resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz", "funding": {"url": "https://x.example"}',
        }),
        "app",
        "npm",
      ),
    ).toBeNull();
    expect(
      privateRegistry(tree({ ".npmrc": "@acme:registry=https://npm.acme.internal/\n" }), "app", "npm"),
    ).toBe(".npmrc names npm.acme.internal");
    expect(
      privateRegistry(tree({ ".npmrc": "//npm.pkg.github.com/:_authToken=abc123\n" }), ".", "npm"),
    ).toContain("configures its own registry or credentials");
    expect(
      privateRegistry(
        tree({ "yarn.lock": 'a@^1:\n  resolved "https://artifactory.acme.io/api/npm/a-1.0.0.tgz"\n' }),
        ".",
        "npm",
      ),
    ).toBe("yarn.lock names artifactory.acme.io");
  });

  it("reads Python's indexes, public mirrors allowed", () => {
    expect(
      privateRegistry(
        tree({
          "uv.lock":
            'source = { registry = "https://pypi.org/simple" }\nsdist = { url = "https://files.pythonhosted.org/p/a.tar.gz" }',
        }),
        ".",
        "pypi",
      ),
    ).toBeNull();
    expect(
      privateRegistry(
        tree({ "pyproject.toml": '[[tool.uv.index]]\nurl = "https://download.pytorch.org/whl/cpu"' }),
        ".",
        "pypi",
      ),
    ).toBeNull();
    expect(
      privateRegistry(
        tree({ "requirements.txt": "--extra-index-url https://pypi.acme.dev/simple\nrequests\n" }),
        ".",
        "pypi",
      ),
    ).toBe("requirements.txt names pypi.acme.dev");
  });

  it("reads Cargo, RubyGems and Maven sources", () => {
    expect(
      privateRegistry(
        tree({
          "Cargo.lock":
            'source = "registry+https://github.com/rust-lang/crates.io-index"\nsource = "sparse+https://index.crates.io/"',
        }),
        ".",
        "cargo",
      ),
    ).toBeNull();
    expect(
      privateRegistry(
        tree({ "Cargo.lock": 'source = "sparse+https://cargo.acme.dev/index/"' }),
        ".",
        "cargo",
      ),
    ).toBe("Cargo.lock names cargo.acme.dev");
    expect(
      privateRegistry(tree({ "Gemfile.lock": "GEM\n  remote: https://rubygems.org/\n" }), ".", "rubygems"),
    ).toBeNull();
    expect(privateRegistry(tree({ Gemfile: 'source "https://gems.acme.dev"\n' }), ".", "rubygems")).toBe(
      "Gemfile names gems.acme.dev",
    );
    expect(
      privateRegistry(
        tree({ "build.gradle.kts": "repositories { mavenCentral(); google() }" }),
        ".",
        "maven",
      ),
    ).toBeNull();
    expect(
      privateRegistry(
        tree({ "build.gradle": "repositories { maven { url 'https://nexus.acme.dev/repo' } }" }),
        ".",
        "maven",
      ),
    ).toBe("build.gradle names nexus.acme.dev");
    expect(privateRegistry(tree({ ".mvn/settings.xml": "<settings/>" }), ".", "maven")).toContain(
      "configures its own",
    );
    expect(privateRegistry(tree({ ".mvn/maven.config": "-T 4" }), ".", "maven")).toBeNull();
  });
});
