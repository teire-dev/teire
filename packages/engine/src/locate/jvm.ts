import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoTree } from "../inventory/tree";
import type { Hit, LocateResult } from "./ts";

/**
 * Java and Kotlin uses of a library's changed API, in the worker without a build (plan S08,
 * research jvm.md Job 5, the candidate pass). Comments and string literals are blanked (offsets
 * kept); imports resolve simple names: explicit, wildcard, `import static`, Kotlin `as` aliases.
 *  - `Class.member(…)`, `Class.FIELD`, `new Class(…)` / Kotlin `Class(…)` resolve through imports;
 *  - a statically imported member used bare resolves the same way;
 *  - `x.member(…)` on an unknown receiver matches by name, only in files that import the library,
 *    and never for names Java/Kotlin objects all have or that the new version still defines;
 *  - `kotlin:` keys (members that became errors for Kotlin callers only) match only in .kt files;
 *  - a call whose argument count fits an overload that still exists is not a break.
 * The sandbox compile is the authority; javap over the compiled classes gives exact sites.
 */
const CORE = new Set(
  (
    "toString equals hashCode getClass clone finalize notify notifyAll wait compareTo length size isEmpty get set put add " +
    "remove contains containsKey iterator stream forEach close run call apply accept test of valueOf values name ordinal " +
    "build builder create append write read flush start stop let also apply run with copy invoke"
  ).split(" "),
);

/** Blank comments and string/char literals, keeping every offset and newline. */
export function maskJvm(source: string) {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === "/" && n === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' && source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const stop = end < 0 ? source.length : end + 3;
      blank(i + 1, stop - 1);
      i = stop;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < source.length && source[k] !== c && source[k] !== "\n") k += source[k] === "\\" ? 2 : 1;
      blank(i + 1, k);
      i = k + 1;
    } else i++;
  }
  return out.join("");
}

interface Imports {
  pkg: string;
  /** Simple name (or alias) → fully qualified class. */
  classes: Map<string, string>;
  /** `import static a.B.m` / Kotlin `import a.B.Companion.m`: member name → owner class. */
  members: Map<string, string>;
  wildcards: string[];
}

function importsOf(masked: string): Imports {
  const pkg = /^\s*package\s+([\w.]+)/m.exec(masked)?.[1] ?? "";
  const classes = new Map<string, string>();
  const members = new Map<string, string>();
  const wildcards: string[] = [];
  for (const m of masked.matchAll(/^\s*import\s+(static\s+)?([\w.]+)(\.\*)?(?:\s+as\s+(\w+))?\s*;?\s*$/gm)) {
    const [, isStatic, path = "", star, alias] = m;
    if (star) {
      if (isStatic) wildcards.push(`static:${path}`);
      else wildcards.push(path);
      continue;
    }
    const last = path.slice(path.lastIndexOf(".") + 1);
    const owner = path.slice(0, path.lastIndexOf("."));
    // A member import: `static`, a lower-case last segment, or a Companion member (Kotlin).
    if (isStatic || /^[a-z_]/.test(last) || owner.endsWith(".Companion"))
      members.set(alias ?? last, owner.replace(/\.Companion$/, ""));
    else classes.set(alias ?? last, path);
  }
  return { pkg, classes, members, wildcards };
}

/** Top-level arguments in `(…)` starting at `open` (the index of `(`), or -1 if unbalanced. */
function argCount(masked: string, open: number) {
  let depth = 0;
  let count = 0;
  let any = false;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") {
      depth--;
      if (depth === 0) return any ? count + 1 : 0;
    } else if (c === "," && depth === 1) count++;
    else if (depth >= 1 && !/\s/.test(c ?? "")) any = true;
  }
  return -1;
}

export function locateJvm(input: {
  repoDir: string;
  tree: RepoTree;
  projectRoot: string;
  /** Package prefixes the library defines (`com.google.common`), from the changed classes. */
  packages: string[];
  declKeys: ReadonlySet<string>;
  /** Member names the new version still defines (by-name matches on them are ambiguous). */
  keptMethodNames?: ReadonlySet<string>;
  /** Removed overloads: key → argument counts that still compile. */
  aritiesLeft?: ReadonlyMap<string, number[]>;
}): LocateResult {
  const started = Date.now();
  const prefix = input.projectRoot === "." ? "" : `${input.projectRoot}/`;
  const files = input.tree
    .files()
    .filter(
      (f) =>
        /\.(?:java|kt)$/.test(f) &&
        f.startsWith(prefix) &&
        !/(?:^|\/)(?:build|target|out|\.gradle|generated)\//.test(f),
    );
  type Target = { key: string; cls: string; member: string | null; kotlinOnly: boolean };
  const targets: Target[] = [...input.declKeys].map((raw) => {
    const kotlinOnly = raw.startsWith("kotlin:");
    const key = kotlinOnly ? raw.slice(7) : raw;
    const hash = key.indexOf("#");
    return {
      key: raw,
      cls: hash < 0 ? key : key.slice(0, hash),
      member: hash < 0 ? null : key.slice(hash + 1),
      kotlinOnly,
    };
  });
  const hits: Hit[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(input.repoDir, file), "utf8");
    } catch {
      continue;
    }
    const kotlin = file.endsWith(".kt");
    const masked = maskJvm(source);
    const imp = importsOf(masked);
    const usesLibrary =
      [
        ...imp.classes.values(),
        ...imp.members.values(),
        ...imp.wildcards.map((w) => w.replace(/^static:/, "")),
      ].some((p) => input.packages.some((pkg) => p === pkg || p.startsWith(`${pkg}.`))) ||
      input.packages.some(
        (pkg) => imp.pkg === pkg || imp.pkg.startsWith(`${pkg}.`) || masked.includes(`${pkg}.`),
      );
    if (!usesLibrary) continue;
    const lines = source.split("\n");
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
    const lineOf = (offset: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] ?? 0) <= offset) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo + 1, column: offset - (starts[lo] ?? 0) + 1 };
    };
    // Names under which a class can be written in this file: imported/aliased simple names, the
    // simple name when its package is wildcard-imported or is this file's, the fully qualified name.
    const spellings = (cls: string) => {
      const dotted = cls.replace(/\$/g, ".");
      const outer = cls.split("$")[0] as string;
      const pkg = outer.slice(0, outer.lastIndexOf("."));
      const simple = dotted.slice(pkg.length + 1);
      const out = new Set<string>([dotted]);
      for (const [name, fq] of imp.classes) {
        if (fq === dotted) out.add(name);
        else if (dotted.startsWith(`${fq}.`)) out.add(`${name}${dotted.slice(fq.length)}`);
      }
      if (imp.wildcards.includes(pkg) || imp.pkg === pkg) out.add(simple);
      return [...out];
    };
    const add = (
      offset: number,
      kind: Hit["kind"],
      key: string,
      resolution: Hit["resolution"],
      args?: number,
    ) => {
      const { line, column } = lineOf(offset);
      if (hits.some((h) => h.file === file && h.line === line && h.declKey === key)) return;
      hits.push({
        file,
        line,
        column,
        kind,
        snippet: (lines[line - 1] ?? "").trim().slice(0, 200),
        resolution,
        declKey: key,
        ...(args !== undefined && args >= 0 ? { argCount: args } : {}),
      });
    };
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stillFits = (key: string, args: number) =>
      args >= 0 && (input.aritiesLeft?.get(key) ?? []).includes(args);
    for (const t of targets) {
      if (t.kotlinOnly && !kotlin) continue;
      const names = spellings(t.cls);
      if (!t.member) {
        // A removed or changed class: every reference to it.
        for (const n of names)
          for (const m of masked.matchAll(
            new RegExp(`(?<![\\w.])${esc(n)}\\b(?!\\s*\\.\\s*[a-z_$][\\w$]*\\s*\\.)`, "g"),
          ))
            add(m.index ?? 0, "type-ref", t.key, "import");
        continue;
      }
      if (t.member === "<init>") {
        for (const n of names) {
          const re = new RegExp(
            kotlin ? `(?<![\\w.])${esc(n)}\\s*\\(` : `\\bnew\\s+${esc(n)}\\s*(?:<[^>]*>)?\\s*\\(`,
            "g",
          );
          for (const m of masked.matchAll(re)) {
            const open = (m.index ?? 0) + m[0].length - 1;
            const args = argCount(masked, open);
            if (!stillFits(t.key, args)) add(m.index ?? 0, "new", t.key, "import", args);
          }
        }
        continue;
      }
      const member = esc(t.member);
      // Qualified through the class (static members, Kotlin companions, fields).
      for (const n of names)
        for (const m of masked.matchAll(
          new RegExp(`(?<![\\w.])${esc(n)}\\s*\\.\\s*${member}\\b(\\s*\\()?`, "g"),
        )) {
          const args = m[1] ? argCount(masked, (m.index ?? 0) + m[0].length - 1) : undefined;
          if (args === undefined || !stillFits(t.key, args))
            add(m.index ?? 0, m[1] ? "call" : "property", t.key, "import", args);
        }
      // Statically imported and used bare.
      const owner = imp.members.get(t.member);
      if (
        owner === t.cls.replace(/\$/g, ".") ||
        imp.wildcards.includes(`static:${t.cls.replace(/\$/g, ".")}`)
      )
        for (const m of masked.matchAll(new RegExp(`(?<![\\w.])${member}\\s*\\(`, "g"))) {
          const args = argCount(masked, (m.index ?? 0) + m[0].length - 1);
          if (!stillFits(t.key, args)) add(m.index ?? 0, "call", t.key, "import", args);
        }
      // By name on an unknown receiver. A `kotlin:` member still exists (a val's getter, Java's
      // bridge): what breaks is calling it as a function from Kotlin, so its name is never ambiguous.
      if (!t.kotlinOnly && (CORE.has(t.member) || input.keptMethodNames?.has(t.member))) continue;
      for (const m of masked.matchAll(new RegExp(`\\.\\s*${member}\\s*\\(`, "g"))) {
        const args = argCount(masked, (m.index ?? 0) + m[0].length - 1);
        if (!stillFits(t.key, args)) add(m.index ?? 0, "call", t.key, "name-only", args);
      }
    }
  }
  return {
    hits,
    imports: [],
    ms: Date.now() - started,
    coverage: {
      filesScanned: files.length,
      filesSkipped: [],
      languages: [...new Set(files.map((f) => (f.endsWith(".kt") ? "kotlin" : "java")))],
      resolutionLevel: "syntax",
      unresolvedSites: 0,
      transitiveAnalysed: false,
    },
  };
}
