import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";

/**
 * Declaration entry points per subpath, resolved the way TypeScript resolves them under
 * `moduleResolution: NodeNext` for an ESM importer: walk `exports` conditions in key order taking
 * `types`, `import`, `node` and `default`; a `.js`/`.mjs`/`.cjs` target means its sibling
 * `.d.ts`/`.d.mts`/`.d.cts` (openai 5's `"./azure": {"import": "./azure.mjs"}` has no `types`).
 * Without `exports`: `types`/`typings`, `main` → `.d.ts`, then `index.d.ts`.
 * Verified on openai 4.104.0 and 5.23.2 (context/09-build-research/generic/js-ts.md §4).
 */
export interface PackageManifest {
  name?: string;
  version?: string;
  types?: string;
  typings?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const CONDITIONS = new Set(["types", "import", "node", "default"]);
const DECL = /\.d\.[cm]?ts$/;

export function readManifest(dir: string): PackageManifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return null;
  }
}

/** First target string the condition walk reaches, or null when every branch is excluded. */
function pickTarget(node: unknown): string | null {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = pickTarget(item);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!CONDITIONS.has(key)) continue;
      const hit = pickTarget(value);
      if (hit) return hit;
    }
  }
  return null;
}

/** A target file → its declaration file inside `dir`, relative, or null. */
export function declarationFor(dir: string, target: string): string | null {
  const rel = normalize(target.replace(/^\.\//, ""));
  if (rel.startsWith("..")) return null;
  const candidates: string[] = [];
  if (DECL.test(rel)) candidates.push(rel);
  else if (rel.endsWith(".mjs"))
    candidates.push(rel.replace(/\.mjs$/, ".d.mts"), rel.replace(/\.mjs$/, ".d.ts"));
  else if (rel.endsWith(".cjs"))
    candidates.push(rel.replace(/\.cjs$/, ".d.cts"), rel.replace(/\.cjs$/, ".d.ts"));
  else if (rel.endsWith(".js")) candidates.push(rel.replace(/\.js$/, ".d.ts"));
  else if (/\.(ts|mts|cts)$/.test(rel)) return null;
  else candidates.push(`${rel}.d.ts`, `${rel}/index.d.ts`);
  return candidates.find((c) => existsSync(join(dir, c))) ?? null;
}

/** `exports` as a subpath map (a bare string or a conditions object means `"."`). */
function subpathMap(exportsField: unknown): Record<string, unknown> | null {
  if (exportsField === undefined || exportsField === null) return null;
  if (typeof exportsField === "string" || Array.isArray(exportsField)) return { ".": exportsField };
  if (typeof exportsField === "object") {
    const keys = Object.keys(exportsField as object);
    if (keys.length && keys.every((k) => !k.startsWith("."))) return { ".": exportsField };
    return exportsField as Record<string, unknown>;
  }
  return null;
}

function legacyRoot(dir: string, manifest: PackageManifest) {
  for (const field of [manifest.types, manifest.typings]) {
    if (typeof field === "string") {
      const hit = declarationFor(dir, field);
      if (hit) return hit;
    }
  }
  if (typeof manifest.main === "string") {
    const hit = declarationFor(dir, manifest.main);
    if (hit) return hit;
  }
  return declarationFor(dir, "index.js");
}

export interface DeclarationEntries {
  /** Subpath → declaration file (relative). */
  entries: Record<string, string>;
  /** Wildcard keys and the target pattern they map to. */
  wildcards: { key: string; target: string }[];
}

export function declarationEntries(dir: string, manifest: PackageManifest): DeclarationEntries {
  const map = subpathMap(manifest.exports);
  const out: DeclarationEntries = { entries: {}, wildcards: [] };
  if (!map) {
    const root = legacyRoot(dir, manifest);
    if (root) out.entries["."] = root;
    return out;
  }
  for (const [key, value] of Object.entries(map)) {
    if (key === "./package.json") continue;
    const target = pickTarget(value);
    if (!target) continue;
    if (key.includes("*")) {
      out.wildcards.push({ key, target });
      continue;
    }
    const decl = declarationFor(dir, target);
    if (decl) out.entries[key] = decl;
  }
  // No "." key means `import "pkg"` itself does not resolve; only the subpaths are public.
  return out;
}

/**
 * Whether `subpath` (`./resources/beta/chat/completions`) resolves to declarations in this
 * version, and where. Used for deep imports a repo actually writes.
 */
export function resolveSubpath(dir: string, manifest: PackageManifest, subpath: string): string | null {
  const map = subpathMap(manifest.exports);
  if (!map) return subpath === "." ? legacyRoot(dir, manifest) : declarationFor(dir, subpath);
  if (subpath in map) {
    const target = pickTarget(map[subpath]);
    return target ? declarationFor(dir, target) : null;
  }
  // Node picks the wildcard key with the longest prefix before `*`.
  let best: { key: string; target: string; match: string } | null = null;
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < key.length - 1) continue;
    const target = pickTarget(value);
    if (target === null) {
      if (!best || prefix.length > best.key.indexOf("*")) best = { key, target: "", match: "" };
      continue;
    }
    if (!best || prefix.length > best.key.indexOf("*"))
      best = { key, target, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  if (!best?.target) return null;
  return declarationFor(dir, best.target.replaceAll("*", best.match));
}

/**
 * Every subpath a wildcard `exports` key makes importable, found by matching the key's declaration
 * target against the package's files (openai 4's `"./*": {"types": "./*.d.ts"}` exposes each
 * `.d.ts`). Keys spelled with a JS extension (`./*.js`) duplicate the bare ones and are skipped.
 */
export function wildcardSubpaths(dir: string, entries: DeclarationEntries, limit: number): string[] {
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (files.length >= limit) return;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && entry.name !== "node_modules") walk(child);
      else if (entry.isFile() && DECL.test(entry.name)) files.push(child);
    }
  };
  walk("");
  const out = new Set<string>();
  for (const { key, target } of entries.wildcards) {
    if (/\.(c|m)?js$/.test(key) || (key.match(/\*/g) ?? []).length !== 1) continue;
    const decl = target
      .replace(/^\.\//, "")
      .replace(/\.mjs$/, ".d.mts")
      .replace(/\.cjs$/, ".d.cts")
      .replace(/\.js$/, ".d.ts");
    const pattern = DECL.test(decl) ? decl : `${decl}.d.ts`;
    const [before = "", after = ""] = pattern.split("*");
    for (const file of files) {
      if (!file.startsWith(before) || !file.endsWith(after) || file.length < before.length + after.length + 1)
        continue;
      const match = file.slice(before.length, file.length - after.length);
      if (match.endsWith("/index")) out.add(key.replace("*", match.slice(0, -"/index".length)));
      out.add(key.replace("*", match));
    }
  }
  return [...out].sort();
}
