import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryCache } from "../src/registry";
import {
  canonicalType,
  declarationEntries,
  IntegrityError,
  normaliseSignature,
  npmSurfaceDiff,
  packageNameOf,
  positionalParams,
  resolveSubpath,
  surfaceChangeRecords,
  typesPackageName,
  verifyIntegrity,
} from "../src/surface";

describe("signature normalisation", () => {
  it("drops unpack locations so two versions compare by API only", () => {
    const cache = "/tmp/teire-packages";
    expect(
      normaliseSignature(`typeof import("/tmp/teire-packages/openai/5.23.2/package/resources/index")`, cache),
    ).toBe(`typeof import("openai/resources/index")`);
    expect(normaliseSignature(`import("/x/y/node_modules/zod/index").ZodType<any>`, cache)).toBe(
      "ZodType<any>",
    );
  });

  it("orders unions and renames value parameters by position", () => {
    expect(canonicalType(`"pending" | "error" | "success"`)).toBe(
      canonicalType(`"error" | "success" | "pending"`),
    );
    // Only ever compared against the other side's positional form, so spacing is irrelevant.
    expect(positionalParams("(threadId: string, body?: Params) => Run")).toBe(
      positionalParams("(runID: string,params?: Params) => Run"),
    );
    // Object members keep their names: they are part of the contract.
    expect(positionalParams("(opts: { model: string }) => void")).toBe("(p0: { model: string }) => void");
  });
});

describe("tarball integrity", () => {
  const bytes = new TextEncoder().encode("package contents");
  const sri = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  it("accepts matching bytes and refuses anything else", () => {
    expect(verifyIntegrity(bytes, sri, null)).toBe(sri);
    expect(() => verifyIntegrity(new TextEncoder().encode("tampered"), sri, null)).toThrow(IntegrityError);
    expect(() => verifyIntegrity(bytes, null, null)).toThrow(IntegrityError);
  });
});

describe("declaration entries", () => {
  // The shape of openai 5's exports: types-less import/require targets and wildcards.
  const dir = mkdtempSync(join(tmpdir(), "teire-entries-"));
  for (const f of ["index.d.mts", "azure.d.mts", "resources/chat/completions.d.mts"]) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "export {};\n");
  }
  const manifest = {
    exports: {
      ".": { types: "./index.d.mts", default: "./index.mjs" },
      "./azure": { import: "./azure.mjs", require: "./azure.js" },
      "./resources/*": { import: "./resources/*.mjs", require: "./resources/*.js" },
      "./package.json": "./package.json",
    },
  };

  it("maps JS targets to sibling declarations and keeps wildcards for deep imports", () => {
    const entries = declarationEntries(dir, manifest);
    expect(entries.entries).toEqual({ ".": "index.d.mts", "./azure": "azure.d.mts" });
    expect(entries.wildcards.map((w) => w.key)).toEqual(["./resources/*"]);
    expect(resolveSubpath(dir, manifest, "./resources/chat/completions")).toBe(
      "resources/chat/completions.d.mts",
    );
    expect(resolveSubpath(dir, manifest, "./resources/beta/chat/completions")).toBeNull();
  });

  it("names packages the way npm and DefinitelyTyped do", () => {
    expect(packageNameOf("@scope/pkg/sub/path")).toBe("@scope/pkg");
    expect(packageNameOf("./local")).toBeNull();
    expect(typesPackageName("@foo/bar")).toBe("@types/foo__bar");
  });
});

// Live: real tarballs from the npm registry, integrity-checked, cached across runs.
const cacheDir = join(tmpdir(), "teire-test-packages");

describe("API-surface diff on real packages", () => {
  it("openai 4.104.0 → 5.23.2 finds what MIGRATION.md lists", { timeout: 180_000 }, async () => {
    const diff = await npmSurfaceDiff("openai", "4.104.0", "5.23.2", { cache: memoryCache(), cacheDir });
    expect(diff.unanalyzable).toBe(false);
    const removed = new Map(diff.changes.filter((c) => c.kind === "removed").map((c) => [c.path, c]));
    for (const path of ["ClientOptions.httpAgent", "fileFromPath", "APIError.request_id", "OpenAI.files.del"])
      expect(removed.has(path), path).toBe(true);
    // The beta.chat namespace went away; its parse() folds into that one removal.
    expect(
      removed.get("OpenAI.beta.chat")?.children?.some((c) => c.path === "OpenAI.beta.chat.completions.parse"),
    ).toBe(true);
    const update = diff.changes.find(
      (c) => c.kind === "arity-changed" && c.path === "OpenAI.beta.threads.runs.update",
    );
    expect(update?.arity).toEqual({ minBefore: 3, maxBefore: 4, minAfter: 2, maxAfter: 3 });
    expect(diff.counts["arity-changed"]).toBe(12);
    // A type alias over CursorPage still has `data`; it must not read as removed.
    expect(removed.has("OpenAI.ChatCompletionsPage.data")).toBe(false);

    const records = surfaceChangeRecords(diff, "2026-10-25T00:00:00.000Z");
    const byKind = Object.fromEntries(records.map((r) => [r.kind, r]));
    expect(byKind["symbol-removed"]?.status).toBe("confirmed");
    expect(byKind["required-added"]?.status).toBe("candidate");
    expect(
      byKind["symbol-removed"]?.signatures.some((s) => s.kind === "symbol" && s.path === "fileFromPath"),
    ).toBe(true);
  });

  it("express 4 → 5 reads DefinitelyTyped with its type dependencies", { timeout: 180_000 }, async () => {
    const diff = await npmSurfaceDiff("express", "4.21.2", "5.1.0", { cache: memoryCache(), cacheDir });
    expect(diff.from.source).toMatchObject({ kind: "definitely-typed", name: "@types/express" });
    const paths = diff.changes.filter((c) => c.kind === "removed").map((c) => c.path);
    expect(paths).toEqual(expect.arrayContaining(["query", "request.param", "response.sendfile"]));
    expect(diff.changes.some((c) => c.kind === "arity-changed" && c.path === "Router.param")).toBe(true);
  });
});
