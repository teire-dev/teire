import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { init as initCjs, parse as parseCjs } from "cjs-module-lexer";
import { init as initEsm, parse as parseEsm } from "es-module-lexer";
import type { PackageManifest } from "./entries";
import type { ApiSurface, ApiSymbol } from "./types";

/**
 * Export names of a package with no declarations at all, read by Node's own lexers, which parse and
 * never execute: cjs-module-lexer for CommonJS (following `module.exports = require('./lib/x')`
 * re-exports), es-module-lexer for ESM. Catches removed exports only, never members or arity, so
 * the surface says "exports only" and a clean diff is low coverage, not "not affected"
 * (research js-ts.md §4: express 4.22.1 → 5.1.0 → `query` removed).
 */
const MAX_REEXPORT_DEPTH = 5;
const JS_TARGET_CONDITIONS = ["require", "node", "default", "import"];

function jsEntry(dir: string, manifest: PackageManifest): string | null {
  const pick = (node: unknown): string | null => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(pick).find(Boolean) ?? null;
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if ("." in obj) return pick(obj["."]);
      for (const key of JS_TARGET_CONDITIONS) if (key in obj) return pick(obj[key]);
    }
    return null;
  };
  const candidates = [pick(manifest.exports), manifest.main, manifest.module, "index.js"].filter(
    (c): c is string => typeof c === "string",
  );
  for (const c of candidates) {
    for (const file of [c, `${c}.js`, `${c}/index.js`]) {
      const rel = normalize(file.replace(/^\.\//, ""));
      if (!rel.startsWith("..") && existsSync(join(dir, rel)) && /\.(c|m)?js$/.test(rel)) return rel;
    }
  }
  return null;
}

let ready: Promise<unknown> | null = null;

export async function exportsOnlySurface(
  dir: string,
  manifest: PackageManifest,
  name: string,
  version: string,
): Promise<ApiSurface | null> {
  const entry = jsEntry(dir, manifest);
  if (!entry) return null;
  ready ??= Promise.all([initCjs(), initEsm()]);
  await ready;

  const names = new Map<string, string>();
  let lexer: "cjs-module-lexer" | "es-module-lexer" = "cjs-module-lexer";
  const visit = (file: string, depth: number) => {
    if (depth > MAX_REEXPORT_DEPTH) return;
    let source: string;
    try {
      source = readFileSync(join(dir, file), "utf8");
    } catch {
      return;
    }
    const esm = file.endsWith(".mjs") || /^\s*(import|export)\s/m.test(source);
    if (esm) {
      lexer = "es-module-lexer";
      const [, exports] = parseEsm(source);
      for (const e of exports) {
        if (e.typeOnly) continue;
        if (e.type === "reexport-all") follow(file, e.from, depth);
        else if (!names.has(e.name)) names.set(e.name, file);
      }
      return;
    }
    const { exports, reexports } = parseCjs(source);
    for (const n of exports) if (n !== "__esModule" && !names.has(n)) names.set(n, file);
    for (const spec of reexports) follow(file, spec, depth);
  };
  const follow = (file: string, spec: string, depth: number) => {
    if (!spec.startsWith(".")) return;
    const base = normalize(join(dirname(file), spec));
    const target = [base, `${base}.js`, `${base}/index.js`].find((f) => existsSync(join(dir, f)));
    if (target) visit(relative(dir, join(dir, target)), depth + 1);
  };
  visit(entry, 0);

  const symbols: Record<string, ApiSymbol> = {};
  for (const [exportName, file] of names) {
    if (exportName === "default") continue;
    symbols[exportName] = {
      path: exportName,
      declKey: `${file.replace(/\.(c|m)?js$/, "")}#${exportName}`,
      kind: "unknown",
      signature: "",
      deprecated: false,
      optional: false,
    };
  }
  return {
    name,
    version,
    source: { kind: "exports-only", lexer },
    entries: { ".": entry },
    wildcards: [],
    symbols,
    byTypeMember: {},
    aliases: {},
    truncated: false,
    note: "no type declarations: export names only (members and arity are not compared)",
  };
}
