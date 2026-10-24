import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DependencyInstance } from "../src/contract";
import { assess, locateTargets, summariseFindings } from "../src/impact";
import { locateTs } from "../src/locate";
import { memoryCache } from "../src/registry";
import { npmSurfaceDiff, npmTypesLayout, surfaceChangeRecords } from "../src/surface";

// Live: the openai tarballs come from the npm registry (integrity-checked, cached across runs).
const options = { cache: memoryCache(), cacheDir: join(tmpdir(), "teire-test-packages") };
const FROM = "4.104.0";
const TO = "5.23.2";

async function run(fixture: string) {
  const repoDir = mkdtempSync(join(tmpdir(), "teire-locate-"));
  cpSync(resolve(import.meta.dirname, "../../../fixtures/locate", fixture), repoDir, { recursive: true });
  const records = surfaceChangeRecords(await npmSurfaceDiff("openai", FROM, TO, options));
  const from = await npmTypesLayout("openai", FROM, options);
  const to = await npmTypesLayout("openai", TO, options);
  const located = locateTs({
    repoDir,
    projectRoot: ".",
    packageName: "openai",
    link: from.link,
    roots: from.roots,
    targetDir: to.link.dir,
    ...locateTargets(records),
  });
  const instance: DependencyInstance = {
    ecosystem: "npm",
    name: "openai",
    version: FROM,
    declaredRange: "^4.104.0",
    direct: true,
    scope: "prod",
    workspace: ".",
    manifestPath: "package.json",
    source: "registry",
    resolvedBy: "lockfile",
  };
  const findings = assess({ instance, target: TO, isMajor: true, records, locate: located });
  return { located, findings, summary: summariseFindings(findings) };
}

describe("locate + impact on the demo sources", () => {
  it("finds every break in demo-npm-major and leaves the look-alike cache alone", {
    timeout: 180_000,
  }, async () => {
    const { located, summary } = await run("major");
    expect(summary.verdict).toBe("affected");
    const sites = summary.breaking.flatMap((f) => f.callSites.map((s) => `${s.file}:${s.line}:${s.kind}`));
    expect(sites).toEqual(
      expect.arrayContaining([
        "src/client.ts:12:property",
        "src/triage.ts:21:call",
        "src/triage.ts:2:import",
      ]),
    );
    expect(located.hits.some((h) => h.file === "src/local-cache.ts")).toBe(false);
    expect(located.coverage).toMatchObject({ resolutionLevel: "type", unresolvedSites: 0 });
  });

  it("calls demo-clean not affected, with its coverage", { timeout: 180_000 }, async () => {
    const { summary } = await run("clean");
    expect(summary.verdict).toBe("not_affected");
    expect(summary.breaking).toEqual([]);
    expect(summary.coverage).toMatchObject({ filesScanned: 2, resolutionLevel: "type", unresolvedSites: 0 });
  });
});
