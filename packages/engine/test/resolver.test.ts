import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  buildJob,
  dependabotDirectory,
  guardedPath,
  jobYaml,
  normalisePypi,
  parseEvents,
  resultOf,
  UnsafePathError,
} from "../src/resolver";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/resolver", name), "utf8");

describe("resolver jobs", () => {
  it("pins a version job to exactly T, across every lockfile root, with no cooldown", () => {
    const { job } = buildJob({
      manager: "yarn",
      ecosystem: "npm",
      repo: "teire-dev/serve-handler",
      commit: "6118ea9c04bb717459f79cdf624b48f1aab22413",
      roots: ["."],
      shape: { kind: "version", dependency: "path-to-regexp", target: "9.0.0" },
    });
    expect(job).toMatchObject({
      command: "update",
      "package-manager": "npm_and_yarn",
      source: { provider: "github", repo: "teire-dev/serve-handler", directory: "/" },
      cooldown: { "default-days": 0 },
      "reject-external-code": false,
      dependencies: ["path-to-regexp"],
      "allowed-updates": [{ "dependency-name": "path-to-regexp" }],
    });
    expect(job["ignore-conditions"]).toContainEqual({
      "dependency-name": "path-to-regexp",
      source: "teire",
      "version-requirement": "> 9.0.0",
    });
    const multi = buildJob({
      manager: "uv",
      ecosystem: "pypi",
      repo: "teire-dev/examples",
      commit: "abc",
      roots: ["py-major", "py-live/", "./py-major"],
      shape: { kind: "version", dependency: "Anthropic_SDK", target: "1.17.0" },
    }).job;
    expect(multi.source).toMatchObject({ directories: ["/py-live", "/py-major"] });
    expect(multi.dependencies).toEqual(["anthropic-sdk"]);
  });

  it("builds security and refresh jobs as the updater parses them", () => {
    const security = buildJob({
      manager: "npm",
      ecosystem: "npm",
      repo: "o/r",
      commit: "abc",
      roots: ["."],
      shape: {
        kind: "security",
        dependency: "minimist",
        advisories: [
          {
            dependencyName: "minimist",
            affectedVersions: ["< 1.2.6"],
            patchedVersions: [">= 1.2.6"],
            unaffectedVersions: [],
          },
        ],
      },
    }).job;
    expect(security["security-updates-only"]).toBe(true);
    expect(security["security-advisories"]).toEqual([
      {
        "dependency-name": "minimist",
        "affected-versions": ["< 1.2.6"],
        "patched-versions": [">= 1.2.6"],
        "unaffected-versions": [],
      },
    ]);
    const refresh = buildJob({
      manager: "bundler",
      ecosystem: "rubygems",
      repo: "o/r",
      commit: "abc",
      roots: ["."],
      shape: { kind: "refresh", dependency: "faraday", version: "2.15.0", prNumber: 7 },
    }).job;
    expect(refresh["updating-a-pull-request"]).toBe(true);
    expect(refresh["existing-pull-requests"]).toEqual([
      {
        "pr-number": 7,
        dependencies: [{ "dependency-name": "faraday", "dependency-version": "2.15.0", directory: "/" }],
      },
    ]);
    // Only refused when private credentials ride along and the repo didn't allow external code (D105).
    const priv = buildJob({
      manager: "pip",
      ecosystem: "pypi",
      repo: "o/r",
      commit: "abc",
      roots: ["."],
      shape: { kind: "version", dependency: "x", target: "1" },
      privateCredentials: true,
    }).job;
    expect(priv["reject-external-code"]).toBe(true);
    expect(
      YAML.parse(
        jobYaml({
          manager: "go",
          ecosystem: "go",
          repo: "o/r",
          commit: "c",
          roots: ["."],
          shape: { kind: "version", dependency: "github.com/a/b", target: "v1.2.3" },
        }),
      ).job["package-manager"],
    ).toBe("go_modules");
  });

  it("names directories and PyPI packages as Dependabot does", () => {
    expect(dependabotDirectory(".")).toBe("/");
    expect(dependabotDirectory("./a/b/")).toBe("/a/b");
    expect(normalisePypi("Typing_Extensions[test]")).toBe("typing-extensions");
  });
});

describe("resolver events", () => {
  it("reads the serve-handler run: the two files, the lead at T, nothing else moved", () => {
    const events = parseEvents(`not json\n${fixture("serve-handler-path-to-regexp.jsonl")}\n{"type": "trunc`);
    const result = resultOf(events, { ecosystem: "npm", name: "path-to-regexp" });
    expect(result.kind).toBe("change");
    if (result.kind !== "change") return;
    expect(result.files.map((f) => f.path).sort()).toEqual(["package.json", "yarn.lock"]);
    expect(result.moved).toEqual([
      { name: "path-to-regexp", from: "3.3.0", to: "9.0.0", removed: false, directory: "/" },
    ]);
    expect(result.leadVersion).toBe("9.0.0");
    expect(result.files.find((f) => f.path === "package.json")?.content).toContain(
      '"path-to-regexp": "9.0.0"',
    );
  });

  it("turns errors into named stops and closes into reasons", () => {
    const stop = resultOf(
      parseEvents(
        '{"type":"record_update_job_error","data":{"error-type":"private_source_timed_out","error-details":{"source":"registry.yarnpkg.com"}}}\n{"type":"mark_as_processed","data":{"base-commit-sha":"x"}}',
      ),
      { ecosystem: "npm", name: "path-to-regexp" },
    );
    expect(stop).toMatchObject({
      kind: "stop",
      type: "private_source_timed_out",
      message: "a package registry did not answer in time (source: registry.yarnpkg.com)",
    });
    expect(
      resultOf(
        parseEvents('{"type":"close_pull_request","data":{"dependency-names":["a"],"reason":"up_to_date"}}'),
        {
          ecosystem: "npm",
          name: "a",
        },
      ),
    ).toEqual({ kind: "close", reason: "up_to_date", dependencies: ["a"] });
  });

  it("keeps bytes, deletions, modes and symlinks, and refuses paths that leave the checkout", () => {
    const pr = (files: unknown[]) =>
      `{"type":"create_pull_request","data":{"base-commit-sha":"x","dependencies":[],"updated-dependency-files":${JSON.stringify(files)}}}`;
    const result = resultOf(
      parseEvents(
        pr([
          {
            name: "bun.lockb",
            directory: "/web",
            content: "AAEC",
            content_encoding: "base64",
            deleted: false,
            operation: "update",
            support_file: false,
          },
          {
            name: "old.lock",
            directory: "/",
            content: "",
            content_encoding: "utf-8",
            deleted: true,
            operation: "delete",
            support_file: false,
          },
          {
            name: "gradlew",
            directory: "/",
            content: "#!/bin/sh",
            content_encoding: "utf-8",
            deleted: false,
            operation: "update",
            support_file: false,
            mode: "100755",
          },
          {
            name: "link",
            directory: "/",
            content: "",
            content_encoding: "utf-8",
            deleted: false,
            operation: "update",
            support_file: false,
            symlink_target: "target.txt",
            mode: "120000",
          },
        ]),
      ),
      { ecosystem: "npm", name: "x" },
    );
    expect(result.kind === "change" && result.files).toEqual([
      { path: "web/bun.lockb", content: "AAEC", encoding: "base64" },
      { path: "old.lock", content: null },
      { path: "gradlew", content: "#!/bin/sh", mode: "100755" },
      { path: "link", content: "target.txt", mode: "120000" },
    ]);
    for (const [dir, name] of [
      ["/", "../../etc/passwd"],
      ["/../x", "a"],
      ["/", ".git/config"],
      ["/", "a\0b"],
    ] as const)
      expect(() => guardedPath(dir, name)).toThrow(UnsafePathError);
  });
});
