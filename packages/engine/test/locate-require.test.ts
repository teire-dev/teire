import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { locateTargets } from "../src/impact";
import { locateTs } from "../src/locate";
import { memoryCache } from "../src/registry";
import { npmSurfaceDiff, npmTypesLayout, surfaceChangeRecords } from "../src/surface";

// Live: the openai tarballs from npm, as in locate.test.ts.
const options = { cache: memoryCache(), cacheDir: join(tmpdir(), "teire-test-packages") };

async function locate(files: Record<string, string>) {
  const repoDir = mkdtempSync(join(tmpdir(), "teire-require-"));
  for (const [path, text] of Object.entries({
    "package.json": '{"name":"app","dependencies":{"openai":"^4.104.0"}}',
    ...files,
  })) {
    mkdirSync(dirname(join(repoDir, path)), { recursive: true });
    writeFileSync(join(repoDir, path), text);
  }
  const records = surfaceChangeRecords(await npmSurfaceDiff("openai", "4.104.0", "5.23.2", options));
  const from = await npmTypesLayout("openai", "4.104.0", options);
  const to = await npmTypesLayout("openai", "5.23.2", options);
  return locateTs({
    repoDir,
    projectRoot: ".",
    packageName: "openai",
    link: from.link,
    roots: from.roots,
    targetDir: to.link.dir,
    ...locateTargets(records),
  });
}

describe("require() and import() count as references (S19)", { timeout: 180_000 }, () => {
  it("resolves a .js require to the package and stays type-level", async () => {
    const located = await locate({
      "src/index.js": 'const OpenAI = require("openai");\nmodule.exports = new OpenAI();\n',
    });
    expect(located.coverage.resolutionLevel).toBe("type");
    expect(located.coverage.unresolvedSites).toBe(0);
  });

  it("never calls a reference it couldn't resolve 'nothing used'", async () => {
    // A .ts require without Node's types is `any`: the package can't be followed from it.
    const ts = await locate({
      "src/index.ts":
        'declare const require: (id: string) => any;\nconst OpenAI = require("openai");\nexport default OpenAI;\n',
    });
    expect(ts.coverage.unresolvedSites).toBeGreaterThan(0);
    // A file that only names the package (a string built at runtime) is not proof of no use.
    const named = await locate({
      "src/load.js": 'const name = "openai";\nmodule.exports = () => require(name);\n',
    });
    expect(named.coverage.unresolvedSites).toBeGreaterThan(0);
    expect(named.coverage.resolutionLevel).toBe("syntax");
  });
});
