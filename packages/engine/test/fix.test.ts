import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyCodemods,
  filesNamed,
  overrideEdit,
  planCodemods,
  renamePairs,
  transitiveUpdateCommand,
} from "../src/fix";
import { memoryTree } from "../src/inventory/tree";
import { memoryCache } from "../src/registry";
import { npmSurface, npmTypesLayout } from "../src/surface";

// Real quote from openai-node's MIGRATION.md (v7 tag), as the notes step keeps it.
const betaChat = {
  summary: "`beta.chat` namespace removed; methods moved to `chat.completions`.",
  apis: ["client.beta.chat.completions.parse()"],
  replacement: "Use `client.chat.completions.parse()`.",
  quote:
    "The `beta.chat` namespace has been removed. All chat completion methods that were previously in beta have been moved to the main `chat.completions` namespace: // Before client.beta.chat.completions.parse(); // After client.chat.completions.parse(); Additionally, related types have been moved: // Before import { ParsedChatCompletion, ParsedChoice, ParsedFunction } from 'openai/resources/beta/chat/completions'; // After import { ParsedChatCompletion, ParsedChoice, ParsedFunction } from 'openai/resources/chat/completions';",
  url: "https://github.com/openai/openai-node/blob/v7.38.0/MIGRATION.md",
};

describe("codemods from quoted migration notes", () => {
  it("reads old → new chains from Before/After and from the replacement", () => {
    expect(renamePairs(betaChat)).toContainEqual([
      "client.beta.chat.completions.parse",
      "client.chat.completions.parse",
    ]);
  });

  it("rewrites demo-npm-major's call and deep import only where the target proves the new side", {
    timeout: 180_000,
  }, async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "teire-codemod-"));
    cpSync(resolve(import.meta.dirname, "../../../fixtures/locate/major"), repoDir, { recursive: true });
    const options = { cache: memoryCache(), cacheDir: join(tmpdir(), "teire-test-packages") };
    const target = await npmSurface("openai", "5.23.2", options);
    const layout = await npmTypesLayout("openai", "5.23.2", options);
    const edits = planCodemods({
      repoDir,
      packageName: "openai",
      sites: [
        { file: "src/triage.ts", line: 21, column: 82, kind: "call", snippet: "", resolution: "type" },
        {
          file: "src/triage.ts",
          line: 2,
          column: 43,
          kind: "import",
          snippet: "openai/resources/beta/chat/completions",
          resolution: "import",
        },
        { file: "src/local-cache.ts", line: 9, column: 7, kind: "property", snippet: "", resolution: "type" },
      ],
      notes: [betaChat],
      targetDir: layout.link.dir,
      targetPaths: new Set(Object.keys(target.surface.symbols)),
    });
    expect(edits.map((e) => `${e.file}:${e.line}`).sort()).toEqual(["src/triage.ts:2", "src/triage.ts:21"]);
    applyCodemods(repoDir, edits);
    const triage = readFileSync(join(repoDir, "src/triage.ts"), "utf8");
    expect(triage).toContain('from "openai/resources/chat/completions"');
    expect(triage).toContain("await client.chat.completions.parse({");
  });
});

describe("agent workspace", () => {
  it("collects the files tsc and vitest name", () => {
    const named = filesNamed(
      "src/runs.ts(5,57): error TS2554: Expected 1-2 arguments\nsrc/client.ts:12:5 - error TS2353\n FAIL  test/triage.test.ts > triage\n node_modules/openai/index.d.ts(1,1): error",
    );
    expect([...named].sort()).toEqual(["src/client.ts", "src/runs.ts"]);
  });
});

describe("transitive bumps", () => {
  it("pins through each manager's override field without reformatting", () => {
    const manifest = '{\n  "name": "app",\n  "dependencies": { "express": "^4.21.2" }\n}\n';
    const tree = memoryTree({ "package.json": manifest });
    expect(overrideEdit(tree, "npm", "package.json", "path-to-regexp", "0.1.12")?.after).toContain(
      '"overrides": {\n    "path-to-regexp": "^0.1.12"\n  }',
    );
    expect(overrideEdit(tree, "pnpm", "package.json", "path-to-regexp", "0.1.12")?.after).toContain('"pnpm"');
    expect(overrideEdit(tree, "yarn", "package.json", "path-to-regexp", "0.1.12")?.after).toContain(
      '"resolutions"',
    );
    expect(transitiveUpdateCommand("npm", "path-to-regexp")).toContain("--package-lock-only");
    expect(transitiveUpdateCommand("yarn", "x", "1")).toBeNull();
  });
});

describe("sandbox names", () => {
  it("give every execution of a run its own sandboxes, within the sandbox id rule", async () => {
    const { sandboxId } = await import("../src/fix/run");
    const run = "06edcb9c-66ca-48f7-a11c-151aa13771bf";
    const a = sandboxId(run, "a1b2c3", "after");
    const b = sandboxId(run, "d4e5f6", "after");
    expect(a).not.toBe(b);
    for (const id of [a, b, sandboxId("eval-demo-kotlin-major-ultra-mh5x9k2a", "a1b2c3", "base")])
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });
});
