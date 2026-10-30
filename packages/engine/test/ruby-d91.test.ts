import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DependencyInstance } from "../src/contract";
import { assess } from "../src/impact";
import { memoryTree } from "../src/inventory/tree";
import { locateRuby } from "../src/locate/ruby";
import type { LocateResult } from "../src/locate/ts";
import { bundlerCooldownDays } from "../src/pipeline/ruby";
import { surfaceChangeRecords } from "../src/surface/records";
import type { SurfaceDiff } from "../src/surface/types";

const side = { ok: true } as unknown as SurfaceDiff["from"];
const diff = {
  ecosystem: "rubygems",
  name: "faraday",
  fromVersion: "1.10.6",
  toVersion: "2.0.0",
  from: side,
  to: side,
  changes: [
    {
      path: "Faraday::Connection#run_request",
      declKey: "Faraday::Connection#run_request",
      kind: "removed",
      symbolKind: "method",
      severity: "breaking",
    },
    {
      path: "faraday/middleware_registry",
      declKey: "faraday/middleware_registry",
      kind: "entry-removed",
      symbolKind: "module",
      severity: "breaking",
    },
  ],
  counts: { removed: 1, "entry-removed": 1 },
  moved: {},
  unanalyzable: false,
  tool: { name: "prism", version: "test" },
} as unknown as SurfaceDiff;

const instance = {
  ecosystem: "rubygems",
  name: "faraday",
  version: "1.10.6",
  direct: true,
  scope: "prod",
  workspace: ".",
  manifestPath: "Gemfile",
  source: "registry",
  resolvedBy: "lockfile",
} as DependencyInstance;

describe("D91: Ruby's statically read surface", () => {
  it("rule 1: a symbol change is a candidate, a removed require path is confirmed", () => {
    const records = surfaceChangeRecords(diff);
    expect(records.find((r) => r.kind === "symbol-removed")?.status).toBe("candidate");
    expect(records.find((r) => r.kind === "deep-import-removed")?.status).toBe("confirmed");
  });

  it("rule 2: a by-name call on a name core Ruby or the new version still answers to is no use", async () => {
    // The locator reads each file from the checkout.
    const repoDir = mkdtempSync(join(tmpdir(), "teire-d91-"));
    const files = {
      "app.rb":
        'require "faraday"\nconn = Faraday.new\nconn.run_request(:get, "/", nil, {})\nlist.to_s\nFaraday.default_connection\n',
    };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(repoDir, path), text);
    const tree = memoryTree(files);
    const located = await locateRuby({
      repoDir,
      tree,
      projectRoot: ".",
      roots: ["Faraday"],
      declKeys: new Set([
        "Faraday::Connection#run_request",
        "Faraday::Connection#to_s",
        "Faraday.default_connection",
      ]),
      keptMethodNames: new Set(["run_request"]),
    });
    // run_request is still defined in 2.0 and to_s is core: neither by name is evidence; the
    // singleton call on its owner resolves.
    expect(located.hits.map((h) => `${h.declKey}:${h.resolution}`)).toEqual([
      "Faraday.default_connection:import",
    ]);
  });

  it("a candidate change whose only sites match by name is inconclusive, not affected", () => {
    const [record] = surfaceChangeRecords(diff).filter((r) => r.kind === "symbol-removed");
    if (!record) throw new Error("no record");
    const locate = {
      hits: [
        {
          file: "app.rb",
          line: 3,
          column: 1,
          kind: "call",
          snippet: "conn.run_request",
          resolution: "name-only",
          declKey: "Faraday::Connection#run_request",
        },
      ],
      imports: [],
      ms: 1,
      coverage: {
        filesScanned: 1,
        filesSkipped: [],
        languages: ["ruby"],
        resolutionLevel: "syntax",
        unresolvedSites: 0,
        transitiveAnalysed: false,
      },
    } as unknown as LocateResult;
    const [finding] = assess({ instance, target: "2.0.0", isMajor: true, records: [record], locate });
    expect(finding?.verdict).toBe("inconclusive");
    expect(finding?.callSites).toHaveLength(1);
  });

  it("rule 3: Bundler's cooldown is the target's age, so the lock lands on the analysed version", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    expect(bundlerCooldownDays("2026-10-20T08:00:00Z", now)).toBe(10);
    expect(bundlerCooldownDays("2026-10-30T11:00:00Z", now)).toBe(0);
  });
});
