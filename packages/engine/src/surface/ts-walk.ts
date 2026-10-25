import { isAbsolute, join, relative, sep } from "node:path";
import ts from "typescript6";
import { SURFACE } from "../constants";
import type { DeclarationEntries } from "./entries";
import type { ApiSurface, ApiSymbol, Arity, SymbolKind, TypeParam, TypesSource } from "./types";

/**
 * Public API surface of a package from its `.d.ts` files, on the TypeScript 6.0.3 compiler API
 * (7.x is the Go port without a JS API; plan D62). Ported from emend's `surface.ts` (MIT,
 * © 2026 Diyan Bogdanov, refs/emend/src/surface.ts): breadth-first over module exports, class and
 * interface members, properties typed by a class (`client.chat.completions.create`) and construct
 * signatures, each symbol claimed once under its shortest path. Teire adds one program over every
 * declared subpath, a declaration key per symbol, and arity read from call signatures instead of
 * parsed out of printed text. Reads declarations only; nothing is executed.
 */
const PRINTER = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function readTypeParams(decl: ts.Declaration): TypeParam[] {
  const params = (decl as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters;
  return params ? params.map((p) => ({ name: p.name.text, defaulted: p.default !== undefined })) : [];
}

function kindOf(flags: ts.SymbolFlags): SymbolKind {
  if (flags & ts.SymbolFlags.Class) return "class";
  if (flags & ts.SymbolFlags.Interface) return "interface";
  if (flags & ts.SymbolFlags.TypeAlias) return "type";
  if (flags & ts.SymbolFlags.Enum) return "enum";
  if (flags & ts.SymbolFlags.Method) return "method";
  if (flags & ts.SymbolFlags.Function) return "function";
  if (flags & (ts.SymbolFlags.Property | ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor))
    return "property";
  if (flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.BlockScopedVariable)) return "variable";
  if (flags & ts.SymbolFlags.Module) return "module";
  return "unknown";
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Type text with what differs only between two unpack locations removed: absolute paths into the
 * package cache become `<package>/<file>`, `import("…").` prefixes go, whitespace collapses.
 */
export function normaliseSignature(raw: string, cacheDir = SURFACE.cacheDir): string {
  const cache = escapeRegExp(cacheDir.replace(/\/+$/, ""));
  let s = raw.replace(
    new RegExp(`(["'])${cache}/((?:@[^/"']+/)?[^/"']+)/[^/"']+/(?:package|node_modules)/([^"']*)\\1`, "g"),
    "$1$2/$3$1",
  );
  s = s.replace(/(["'])[^"']*\/node_modules\/((?:@[^/"']+\/)?[^/"']+)\/([^"']*)\1/g, "$1$2/$3$1");
  s = s.replace(/import\((?:"[^"]*"|'[^']*')\)\./g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > SURFACE.maxSignatureChars ? `${s.slice(0, SURFACE.maxSignatureChars)}…<truncated>` : s;
}

/**
 * Type text with every union in one order and trailing type arguments that restate a declared
 * default dropped, parsed rather than scanned (emend's `canonicalType`; text the parser rejects,
 * such as `... 5 more ...` elisions, is returned untouched).
 */
export function canonicalType(signature: string, defaults?: ReadonlyMap<string, readonly string[]>): string {
  const file = ts.createSourceFile(
    "__canonical.ts",
    `type __E = ${signature};`,
    ts.ScriptTarget.Latest,
    false,
  );
  const problems = (file as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (Array.isArray(problems) && problems.length > 0) return signature;
  const declaration = file.statements[0];
  if (file.statements.length !== 1 || !declaration || !ts.isTypeAliasDeclaration(declaration))
    return signature;
  const show = (node: ts.Node) => PRINTER.printNode(ts.EmitHint.Unspecified, node, file);
  const transformed = ts.transform(declaration.type, [
    (context) => (root) => {
      const visit = (node: ts.Node): ts.Node => {
        const visited = ts.visitEachChild(node, visit, context);
        if (ts.isTypeReferenceNode(visited) && visited.typeArguments) {
          const declared = defaults?.get(visited.typeName.getText(file));
          if (declared) {
            const given = visited.typeArguments;
            let keep = given.length;
            while (keep > 0 && declared[keep - 1] !== undefined && declared[keep - 1] !== "") {
              const arg = given[keep - 1];
              if (!arg || show(arg) !== declared[keep - 1]) break;
              keep--;
            }
            if (keep < given.length)
              return ts.factory.updateTypeReferenceNode(
                visited,
                visited.typeName,
                keep === 0 ? undefined : ts.factory.createNodeArray(given.slice(0, keep)),
              );
          }
        }
        if (!ts.isUnionTypeNode(visited)) return visited;
        const ordered = [...visited.types].sort((a, b) => {
          const [x, y] = [show(a), show(b)];
          return x < y ? -1 : x > y ? 1 : 0;
        });
        return ts.factory.updateUnionTypeNode(visited, ts.factory.createNodeArray(ordered));
      };
      return ts.visitNode(root, visit) as ts.TypeNode;
    },
  ]);
  const out = transformed.transformed[0];
  const text = out ? show(out) : signature;
  transformed.dispose();
  return text.replace(/\s+/g, " ").trim();
}

const partsToText = (parts?: ts.SymbolDisplayPart[]) =>
  (parts ?? [])
    .map((p) => p.text)
    .join("")
    .trim();

function deprecation(sym: ts.Symbol, checker: ts.TypeChecker): { deprecated: boolean; doc?: string } {
  try {
    const tags = sym.getJsDocTags(checker);
    if (!tags.some((t) => t.name === "deprecated")) return { deprecated: false };
    const description = partsToText(sym.getDocumentationComment(checker));
    const inline = tags
      .filter((t) => t.name === "deprecated" || t.name === "see")
      .map((t) => partsToText(t.text))
      .filter(Boolean);
    const doc = [description, ...inline].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return doc ? { deprecated: true, doc: doc.slice(0, 600) } : { deprecated: true };
  } catch {
    return { deprecated: false };
  }
}

/** Fewest and most arguments any call (or construct) signature accepts; -1 when unbounded. */
function arityOf(signatures: readonly ts.Signature[], checker: ts.TypeChecker): Arity | undefined {
  if (signatures.length === 0) return undefined;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const sig of signatures) {
    let required = 0;
    let rest = false;
    const params = sig.getParameters();
    params.forEach((p, i) => {
      const d = p.valueDeclaration;
      if (d && ts.isParameter(d)) {
        if (d.dotDotDotToken) rest = true;
        else if (!(d.questionToken || d.initializer || checker.isOptionalParameter(d))) required = i + 1;
      }
    });
    min = Math.min(min, required);
    max = max === -1 || rest ? -1 : Math.max(max, params.length);
  }
  return { min: Number.isFinite(min) ? min : 0, max };
}

/** `private` and `protected` members are not part of what a caller can reach. */
function isHidden(sym: ts.Symbol) {
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  return (
    !!decl &&
    (ts.getCombinedModifierFlags(decl) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0
  );
}

function isLibSymbol(sym: ts.Symbol, program: ts.Program) {
  const decls = sym.declarations;
  return !!decls?.length && decls.every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()));
}

/** Exports of the module a declaration file stands for: ES module, `export =`, or `declare module`. */
function resolveModuleSymbol(source: ts.SourceFile, checker: ts.TypeChecker): ts.Symbol | undefined {
  const fileSymbol = checker.getSymbolAtLocation(source);
  if (fileSymbol && checker.getExportsOfModule(fileSymbol).length > 0) return fileSymbol;
  const exportEquals = fileSymbol?.exports?.get("export=" as ts.__String);
  if (exportEquals) {
    try {
      const target =
        exportEquals.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exportEquals) : exportEquals;
      if (checker.getExportsOfModule(target).length > 0) return target;
      if (target.exports && target.exports.size > 0) return target;
    } catch {
      // fall through to ambient modules
    }
  }
  let best: ts.Symbol | undefined;
  let bestCount = 0;
  for (const statement of source.statements) {
    if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)) continue;
    const sym = checker.getSymbolAtLocation(statement.name);
    if (!sym) continue;
    try {
      const count = checker.getExportsOfModule(sym).length;
      if (count > bestCount) {
        best = sym;
        bestCount = count;
      }
    } catch {
      // unusable declaration
    }
  }
  return best ?? fileSymbol;
}

function collectTypeDefaults(program: ts.Program, checker: ts.TypeChecker) {
  const out: Record<string, string[]> = {};
  for (const file of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(file)) continue;
    ts.forEachChild(file, function walk(node) {
      const decl = node as unknown as {
        name?: ts.Identifier;
        typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration>;
      };
      const named =
        ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node);
      if (named && decl.name && decl.typeParameters?.length && out[decl.name.text] === undefined) {
        out[decl.name.text] = decl.typeParameters.map((param) => {
          if (!param.default) return "";
          try {
            return checker.typeToString(checker.getTypeFromTypeNode(param.default));
          } catch {
            return "";
          }
        });
      }
      ts.forEachChild(node, walk);
    });
  }
  return out;
}

function collectTypeAliases(program: ts.Program, checker: ts.TypeChecker) {
  const out: Record<string, string> = {};
  for (const file of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(file)) continue;
    ts.forEachChild(file, function walk(node) {
      if (ts.isTypeAliasDeclaration(node) && (node.typeParameters?.length ?? 0) === 0) {
        const name = node.name.text;
        if (out[name] === undefined) {
          try {
            const expanded = checker.typeToString(
              checker.getTypeAtLocation(node.name),
              undefined,
              ts.TypeFormatFlags.InTypeAlias,
            );
            if (expanded !== name && expanded !== "any" && expanded.length <= SURFACE.maxAliasExpansion)
              out[name] = expanded;
          } catch {
            // unresolvable: record nothing
          }
        }
      }
      ts.forEachChild(node, walk);
    });
  }
  return out;
}

export interface WalkInput {
  pkgDir: string;
  name: string;
  version: string;
  source: TypesSource;
  entries: DeclarationEntries;
  /** Flat `node_modules` holding the type-dependency closure, when materialised. */
  nodeModules?: string;
  /** Package names in that closure. */
  typeDeps?: string[];
  cacheDir?: string;
}

export function extractTsSurface(input: WalkInput): ApiSurface {
  const { pkgDir, name, version, source, entries } = input;
  const base: ApiSurface = {
    name,
    version,
    source,
    entries: entries.entries,
    wildcards: entries.wildcards.map((w) => w.key),
    typeDeps: input.typeDeps ?? [],
    symbols: {},
    byTypeMember: {},
    aliases: {},
    truncated: false,
  };
  const ordered = Object.entries(entries.entries).sort(([a], [b]) =>
    a === "." ? -1 : b === "." ? 1 : a.localeCompare(b),
  );
  if (ordered.length === 0) return { ...base, note: "package ships no TypeScript declarations" };

  const program = ts.createProgram(
    ordered.map(([, file]) => join(pkgDir, file)),
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
      noEmit: true,
      strict: false,
      types: [],
      // Default type roots follow the working directory and would pull in Teire's own @types;
      // with none, `/// <reference types>` resolves only through the package's closure.
      typeRoots: [],
      // The type-dependency closure is symlinked into one flat node_modules; keeping the link
      // paths is what lets second-level dependencies resolve from it.
      preserveSymlinks: true,
    },
  );
  const checker = program.getTypeChecker();
  const roots = [pkgDir, input.nodeModules]
    .filter((r): r is string => !!r)
    .map((r) => r.split(sep).join("/"));
  const inScope = (sym: ts.Symbol) =>
    !!sym.declarations?.some((d) => {
      const f = d.getSourceFile().fileName.split(sep).join("/");
      return roots.some((r) => f.startsWith(`${r}/`));
    });

  const relFile = (fileName: string) => {
    const f = fileName.split(sep).join("/");
    const nm = input.nodeModules?.split(sep).join("/");
    const rel =
      nm && f.startsWith(`${nm}/`)
        ? `node_modules/${f.slice(nm.length + 1)}`
        : relative(pkgDir, f).split(sep).join("/");
    return (isAbsolute(rel) || rel.startsWith("..") ? f : rel).replace(/\.d\.[cm]?ts$/, "");
  };
  const declKeyOf = (sym: ts.Symbol, decl: ts.Declaration) => {
    let qualified = sym.getName();
    try {
      qualified = checker.getFullyQualifiedName(sym).replace(/^"[^"]*"\.?/, "") || sym.getName();
    } catch {
      // keep the bare name
    }
    return `${relFile(decl.getSourceFile().fileName)}#${qualified}`;
  };

  const symbols: Record<string, ApiSymbol> = {};
  const byTypeMember: Record<string, string> = {};
  const aliases: Record<string, string> = {};
  const claimed = new Map<ts.Symbol, string>();
  const queue: { sym: ts.Symbol; path: string; depth: number; parent?: string }[] = [];
  let truncated = false;

  const resolveAlias = (sym: ts.Symbol) => {
    if (!(sym.flags & ts.SymbolFlags.Alias)) return sym;
    try {
      return checker.getAliasedSymbol(sym);
    } catch {
      return sym;
    }
  };
  const enqueue = (sym: ts.Symbol, path: string, depth: number, parent?: string): string | null => {
    if (depth > SURFACE.maxDepth || isLibSymbol(sym, program)) return null;
    const resolved = resolveAlias(sym);
    const existing = claimed.get(resolved);
    if (existing !== undefined) {
      if (existing !== path) aliases[path] = existing;
      return existing;
    }
    if (claimed.size >= SURFACE.maxSymbols) {
      truncated = true;
      return null;
    }
    claimed.set(resolved, path);
    queue.push({ sym: resolved, path, depth, ...(parent ? { parent } : {}) });
    return path;
  };

  const notes: string[] = [];
  const seed = (subpath: string, file: string) => {
    const sourceFile = program.getSourceFile(join(pkgDir, file));
    if (!sourceFile) {
      notes.push(`${subpath}: declarations did not load`);
      return;
    }
    const moduleSymbol = resolveModuleSymbol(sourceFile, checker);
    const prefix = subpath === "." ? "" : `${subpath.slice(2)}:`;
    const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    if (exports.length === 0 && subpath === ".") {
      // Ambient-only packages (`@types/node`: `declare module "fs" { … }` across many files): each
      // module the package declares is part of its API, named by the module.
      for (const ambient of checker.getAmbientModules()) {
        if (!inScope(ambient)) continue;
        const moduleName = ambient.getName().replace(/^["']|["']$/g, "");
        for (const exp of checker.getExportsOfModule(ambient))
          enqueue(exp, `${moduleName}:${exp.getName()}`, 0);
      }
      return;
    }
    for (const exp of exports) {
      const exportName = exp.getName();
      // A default-exported class is used under its declared name (`new OpenAI()`), not "default".
      if (exportName === "default") {
        const declared = resolveAlias(exp).getName();
        if (declared && declared !== "default" && /^[A-Za-z_$][\w$]*$/.test(declared))
          enqueue(exp, `${prefix}${declared}`, 0);
      }
      enqueue(exp, `${prefix}${exportName}`, 0);
    }
  };

  const drain = () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { sym, path, depth, parent } = item;
      const decl = sym.valueDeclaration ?? sym.declarations?.[0];
      if (!decl) continue;
      let type: ts.Type | undefined;
      let signature = "unresolved";
      try {
        type = sym.valueDeclaration
          ? checker.getTypeOfSymbolAtLocation(sym, sym.valueDeclaration)
          : checker.getDeclaredTypeOfSymbol(sym);
        signature = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
      } catch {
        // unresolved
      }
      const kind = kindOf(sym.flags);
      const typeParams = readTypeParams(decl);
      const dep = deprecation(sym, checker);
      let arity: Arity | undefined;
      try {
        // A `const` or property holding a function (`export const record = ZodRecord.create`) is
        // called like one, so its call signatures count too.
        if (type && (kind === "function" || kind === "method" || kind === "variable" || kind === "property"))
          arity = arityOf(type.getCallSignatures(), checker);
        else if (type && kind === "class") arity = arityOf(type.getConstructSignatures(), checker);
      } catch {
        // no arity
      }
      symbols[path] = {
        path,
        declKey: declKeyOf(sym, decl),
        kind,
        signature: normaliseSignature(signature, input.cacheDir),
        deprecated: dep.deprecated,
        ...(dep.doc ? { doc: dep.doc } : {}),
        optional: Boolean(sym.flags & ts.SymbolFlags.Optional),
        ...(typeParams.length ? { typeParams } : {}),
        ...(arity ? { arity } : {}),
        ...(parent ? { parent } : {}),
      };

      // Re-exports from other packages are recorded but not walked: their internals are theirs.
      if (depth >= SURFACE.maxDepth || !inScope(sym)) continue;
      // Additive: a symbol can be a class, a namespace and a value at once (`OpenAI` is a class merged
      // with a namespace holding `Beta`, `Chat`, …), and each side contributes members.
      const members = new Set<ts.Symbol>();
      const add = (list: readonly ts.Symbol[]) => {
        for (const m of list) members.add(m);
      };
      let owner: string | undefined;
      try {
        if (sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) {
          const declared = checker.getDeclaredTypeOfSymbol(sym);
          add(checker.getPropertiesOfType(declared));
          owner = declared.symbol?.getName() ?? sym.getName();
        }
        if (sym.flags & ts.SymbolFlags.Class && type) add(checker.getPropertiesOfType(type));
        // `type ChatCompletionsPage = CursorPage<ChatCompletion>`: its members are still `page.data`.
        if (sym.flags & ts.SymbolFlags.TypeAlias) {
          const declared = checker.getDeclaredTypeOfSymbol(sym);
          if (declared.flags & ts.TypeFlags.Object || declared.isIntersection()) {
            add(checker.getPropertiesOfType(declared));
            owner ??= sym.getName();
          }
        }
        if (sym.flags & ts.SymbolFlags.Module) add(checker.getExportsOfModule(sym));
        if (
          type &&
          sym.flags & (ts.SymbolFlags.Property | ts.SymbolFlags.Variable | ts.SymbolFlags.BlockScopedVariable)
        ) {
          add(checker.getPropertiesOfType(type));
          owner ??= type.symbol?.getName();
        }
        // `export declare const X: typeof Core & Constructor<…>`: the API is on `new X()`.
        if (type && !(sym.flags & ts.SymbolFlags.Class)) {
          for (const sig of type.getConstructSignatures()) {
            const instance = sig.getReturnType();
            add(checker.getPropertiesOfType(instance));
            owner ??= instance.symbol?.getName() ?? sym.getName();
          }
        }
      } catch {
        // keep what was found
      }
      for (const m of members) {
        const memberName = m.getName();
        if (memberName.startsWith("_") || memberName.startsWith("#") || memberName === "prototype") continue;
        if (isHidden(m)) continue;
        const canonical = enqueue(m, `${path}.${memberName}`, depth + 1, path);
        if (canonical === null) continue;
        if (owner && owner !== "__type" && owner !== "__object") {
          const key = `${owner}.${memberName}`;
          if (!(key in byTypeMember)) byTypeMember[key] = canonical;
        }
      }
    }
  };

  // The main import first, to the end, so a symbol reachable from it is named the way users
  // reach it (`OpenAI.chat.completions.create`); other subpaths then add what only they expose.
  for (const [subpath, file] of ordered.filter(([k]) => k === ".")) seed(subpath, file);
  drain();
  for (const [subpath, file] of ordered.filter(([k]) => k !== ".")) seed(subpath, file);
  drain();

  if (Object.keys(symbols).length === 0)
    return {
      ...base,
      truncated,
      note: "declarations resolved but produced no symbols (types generated at install time, or re-exported from a package not in the tarball)",
    };
  return {
    ...base,
    symbols,
    byTypeMember,
    aliases,
    typeAliases: collectTypeAliases(program, checker),
    typeDefaults: collectTypeDefaults(program, checker),
    truncated,
    ...(truncated
      ? { note: `walk stopped at ${SURFACE.maxSymbols} symbols; removals are not reported` }
      : notes.length
        ? { note: notes.join("; ") }
        : {}),
  };
}
