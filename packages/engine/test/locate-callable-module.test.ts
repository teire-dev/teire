import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { locateTargets } from "../src/impact";
import { locateTs } from "../src/locate";
import { memoryCache } from "../src/registry";
import { npmSurfaceDiff, npmTypesLayout, surfaceChangeRecords } from "../src/surface";

// Live: minimatch's tarballs from npm (3.1.5 typed by @types/minimatch's `export = M`; 10.x by its own ESM types).
it("a module that was itself a function (`module.exports = fn`) and no longer is: its callers are found", {
  timeout: 300_000,
}, async () => {
  const options = { cache: memoryCache(), cacheDir: join(tmpdir(), "teire-test-packages") };
  const repoDir = mkdtempSync(join(tmpdir(), "teire-callable-"));
  for (const [path, text] of Object.entries({
    "package.json": '{"name":"app","dependencies":{"minimatch":"3.1.5"}}',
    "src/index.js":
      "const minimatch = require('minimatch');\nmodule.exports = (resolvedPath, slashed) => {\n  if (minimatch(resolvedPath, slashed)) return true;\n  return false;\n};\n",
  })) {
    mkdirSync(dirname(join(repoDir, path)), { recursive: true });
    writeFileSync(join(repoDir, path), text);
  }
  const records = surfaceChangeRecords(await npmSurfaceDiff("minimatch", "3.1.5", "10.2.6", options));
  const removed = records.find((r) => r.kind === "symbol-removed");
  expect(removed?.signatures.some((s) => s.kind === "symbol" && s.path === "export=")).toBe(true);
  const from = await npmTypesLayout("minimatch", "3.1.5", options);
  const to = await npmTypesLayout("minimatch", "10.2.6", options);
  const located = locateTs({
    repoDir,
    projectRoot: ".",
    packageName: "minimatch",
    link: from.link,
    roots: from.roots,
    targetDir: to.link.dir,
    ...locateTargets(records),
  });
  expect(located.hits.map((h) => [h.file, h.line, h.kind])).toEqual([["src/index.js", 3, "call"]]);
});
