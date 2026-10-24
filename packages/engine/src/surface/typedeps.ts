import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import semver from "semver";
import { SURFACE } from "../constants";
import { getPackageInfo, type RegistryOptions } from "../registry/clients";
import { readManifest } from "./entries";
import { fetchNpmPackage } from "./npm-package";

/**
 * Puts a package's declared type dependencies where TypeScript's resolver looks, so declarations
 * that re-export from another package resolve (`@types/express` → `express-serve-static-core`:
 * 33 symbols alone, 309 with its type dependencies, research js-ts.md §4). Ported from emend's
 * `materializeTypeDeps` (MIT, refs/emend/src/typescript/typedeps.ts) with three changes: every
 * tarball goes through the integrity-checked fetch, the closure is one flat `node_modules`
 * beside the package and the program runs with `preserveSymlinks` so second-level dependencies
 * resolve too, and `/// <reference types="node" />` maps to a declared `@types/node`.
 */
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

const PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /<reference\s+types\s*=\s*['"]([^'"]+)['"]/g,
];

/** `@scope/pkg/sub` → `@scope/pkg`; relative, absolute and `node:` specifiers → null. */
export function packageNameOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return name && name !== "@" ? name : null;
}

/** DefinitelyTyped name for a package: `express` → `@types/express`, `@foo/bar` → `@types/foo__bar`. */
export function typesPackageName(name: string) {
  return `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
}

async function declarationImports(dir: string) {
  const files: string[] = [];
  const walk = async (d: string) => {
    if (files.length >= SURFACE.typeDepFileCap) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= SURFACE.typeDepFileCap) return;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) await walk(join(d, e.name));
      } else if (e.isFile() && /\.d\.[cm]?ts$/.test(e.name)) files.push(join(d, e.name));
    }
  };
  await walk(dir);
  const found = new Set<string>();
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const re of PATTERNS) {
      for (const m of text.matchAll(re)) {
        const spec = m[1] ?? "";
        const name = spec.startsWith("node:") ? "node" : packageNameOf(spec);
        if (!name) continue;
        // Node built-ins and `/// <reference types="node" />` come from a declared @types/node.
        found.add(name === "node" || NODE_BUILTINS.has(name) ? "@types/node" : name);
      }
    }
  }
  return found;
}

export interface TypeDepsResult {
  /** The flat `node_modules` the closure lives in. */
  nodeModules: string;
  packages: { name: string; version: string }[];
  unresolved: string[];
}

/** Materialises the type-dependency closure of the package unpacked at `pkgDir`. */
export async function materializeTypeDeps(
  pkgDir: string,
  options: RegistryOptions & { cacheDir?: string },
): Promise<TypeDepsResult> {
  const nodeModules = join(dirname(pkgDir), "node_modules");
  const stamp = join(nodeModules, ".teire-typedeps.json");
  try {
    return JSON.parse(await readFile(stamp, "utf8")) as TypeDepsResult;
  } catch {
    // not materialised yet
  }
  const result: TypeDepsResult = { nodeModules, packages: [], unresolved: [] };
  const seen = new Set<string>([readManifest(pkgDir)?.name ?? ""]);
  let queue = [{ dir: pkgDir, depth: 0 }];

  while (queue.length) {
    const next: typeof queue = [];
    for (const { dir, depth } of queue) {
      if (depth >= SURFACE.typeDepDepth || seen.size >= SURFACE.typeDepTotalCap) continue;
      const manifest = readManifest(dir);
      if (!manifest) continue;
      const declared = { ...manifest.peerDependencies, ...manifest.dependencies };
      for (const name of await declarationImports(dir)) {
        if (seen.has(name) || seen.size >= SURFACE.typeDepTotalCap) continue;
        // Only declared dependencies: an undeclared import is supplied by the consumer or is a
        // publishing bug, and guessing a version would be worse than leaving it unresolved.
        const declaredName =
          declared[name] !== undefined
            ? name
            : declared[typesPackageName(name)]
              ? typesPackageName(name)
              : null;
        const range = declaredName ? declared[declaredName] : undefined;
        if (!declaredName || !range || /^(file:|link:|workspace:|git|https?:|npm:)/.test(range)) continue;
        seen.add(name);
        seen.add(declaredName);
        try {
          const info = await getPackageInfo("npm", declaredName, options);
          const version =
            info &&
            semver.maxSatisfying(
              info.versions.map((v) => v.version),
              range,
            );
          if (!version) {
            result.unresolved.push(`${declaredName}@${range}`);
            continue;
          }
          const dep = await fetchNpmPackage(declaredName, version, options);
          const link = join(nodeModules, declaredName);
          await mkdir(dirname(link), { recursive: true });
          await symlink(dep.dir, link, "dir").catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
          result.packages.push({ name: declaredName, version });
          next.push({ dir: dep.dir, depth: depth + 1 });
        } catch {
          result.unresolved.push(`${declaredName}@${range}`);
        }
      }
    }
    queue = next;
  }
  await mkdir(nodeModules, { recursive: true });
  await writeFile(stamp, JSON.stringify(result));
  return result;
}
