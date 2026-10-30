import { describe, expect, it } from "vitest";
import { planManifestEdits } from "../src/fix/upgrade-js";
import { readJsProject, yarnPatch } from "../src/inventory/js";
import { memoryTree } from "../src/inventory/tree";
import { patchedHold } from "../src/registry/target";

const PNPM_LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      express:
        specifier: ^4.18.1
        version: 4.18.1
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0
      '@std/path':
        specifier: jsr:^1.0.0
        version: '@jsr/std__path@1.0.8'
`;

describe("patched and JSR npm dependencies (D-23)", () => {
  it("unwraps Yarn's patch: range to the package, its range and the patch file", () => {
    expect(
      yarnPatch(
        "patch:lodash@npm%3A4.17.21#~/.yarn/patches/lodash-npm-4.17.21-6382451519.patch::locator=app%40workspace%3A.",
      ),
    ).toEqual({
      name: "lodash",
      range: "4.17.21",
      file: "~/.yarn/patches/lodash-npm-4.17.21-6382451519.patch",
    });
    expect(yarnPatch("^4.17.21")).toBeNull();
  });

  it("marks pnpm and patch-package patches, and classifies jsr: as not npm", () => {
    const tree = memoryTree({
      "package.json": JSON.stringify({
        dependencies: { express: "^4.18.1", "left-pad": "^1.3.0", "@std/path": "jsr:^1.0.0" },
        pnpm: { patchedDependencies: { "express@4.18.1": "patches/express@4.18.1.patch" } },
      }),
      "pnpm-lock.yaml": PNPM_LOCK,
      "patches/express@4.18.1.patch": "diff",
      "patches/left-pad+1.3.0.patch": "diff",
    });
    const project = readJsProject(tree, ".");
    const of = (name: string) => project.instances.find((i) => i.name === name && i.direct);
    expect(of("express")?.sourceRef).toBe("patch:patches/express@4.18.1.patch");
    expect(of("left-pad")?.sourceRef).toBe("patch:patches/left-pad+1.3.0.patch");
    expect(of("@std/path")?.source).toBe("unknown");
  });

  it("holds an upgrade of a patched package and never rewrites a patch: range", () => {
    const decision = patchedHold(
      {
        kind: "upgrade",
        from: "4.18.1",
        to: "5.1.0",
        isMajor: true,
        publishedAt: null,
        fallbackMajors: 0,
        cooldownWaived: false,
        skipped: [],
      },
      { name: "express", sourceRef: "patch:patches/express@4.18.1.patch" },
    );
    expect(decision).toMatchObject({ kind: "blocked", from: "4.18.1" });
    expect(decision.kind === "blocked" && decision.reason).toContain("remake the patch for 5.1.0");
    const tree = memoryTree({
      "package.json": JSON.stringify({
        dependencies: { lodash: "patch:lodash@npm%3A4.17.21#./lodash.patch" },
      }),
    });
    expect(
      planManifestEdits(
        tree,
        {
          ecosystem: "npm",
          name: "lodash",
          version: "4.17.21",
          declaredRange: "4.17.21",
          direct: true,
          scope: "prod",
          workspace: ".",
          manifestPath: "package.json",
          source: "registry",
          resolvedBy: "lockfile",
        },
        "4.17.22",
      ),
    ).toEqual([]);
  });
});

describe("peer-only and peer-plus-dev npm dependencies (D-22)", () => {
  const instance = {
    ecosystem: "npm",
    name: "react",
    version: "18.3.1",
    declaredRange: "^18.2.0",
    direct: true,
    scope: "dev",
    workspace: ".",
    manifestPath: "package.json",
    source: "registry",
    resolvedBy: "lockfile",
  } as const;

  it("bumps the installed range and widens the peer range in one manifest", () => {
    const text = JSON.stringify(
      { peerDependencies: { react: "^17.0.0 || ^18.0.0" }, devDependencies: { react: "^18.2.0" } },
      null,
      2,
    );
    const edits = planManifestEdits(memoryTree({ "package.json": text }), instance, "19.1.0");
    expect(edits.map((e) => [e.from, e.to, e.note])).toEqual([
      ["^18.2.0", "^19.1.0", undefined],
      ["^17.0.0 || ^18.0.0", "^17.0.0 || ^18.0.0 || ^19.1.0", "peer range widened"],
    ]);
    const final = JSON.parse(edits.at(-1)?.after ?? "{}");
    expect(final.devDependencies.react).toBe("^19.1.0");
    expect(final.peerDependencies.react).toBe("^17.0.0 || ^18.0.0 || ^19.1.0");
  });

  it("leaves a peer range that already allows the target", () => {
    const text = JSON.stringify({ peerDependencies: { react: ">=17" } });
    expect(
      planManifestEdits(memoryTree({ "package.json": text }), { ...instance, scope: "peer" }, "19.1.0"),
    ).toEqual([]);
  });
});

describe("workspaces in build-output folder names (D-21)", () => {
  it("reads packages/build when a workspace glob names it, and no other build folder", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { directoryTree } = await import("../src/inventory/tree");
    const dir = mkdtempSync(join(tmpdir(), "teire-js-build-"));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), text);
      };
      write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
      write("packages/build/package.json", JSON.stringify({ dependencies: { rollup: "^4.0.0" } }));
      write("dist/package.json", JSON.stringify({ dependencies: { leftover: "^1.0.0" } }));
      const project = readJsProject(directoryTree(dir), ".");
      expect(project.importers).toContain("packages/build");
      expect(project.instances.some((i) => i.name === "rollup")).toBe(true);
      expect(project.instances.some((i) => i.name === "leftover")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
