import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { Node, Project, ts } from "ts-morph";
import type { CallSite, Coverage } from "../contract";
import { readManifest, resolveSubpath } from "../surface/entries";

/**
 * Type-resolved uses of one package's changed symbols in a JS/TS repo (plan S02a task 6, research
 * js-ts.md §5). The installed version's verified package files are linked at
 * `node_modules/<pkg>` (types only; nothing installed, nothing executed); every identifier whose
 * name a change mentions is resolved by the compiler, and its declaration key joins it to the diff.
 * A look-alike object (`fake.beta.chat.completions.parse`) resolves to the repo's own declaration
 * and is not a hit. Files are read only from inside the repo; the repo's tsconfig contributes
 * compiler options, never file lists.
 */
export interface PackageRoot {
  /** Real directory of an unpacked package. */
  dir: string;
  /** Prefix its files carry in declaration keys: "" for the package itself, `node_modules/<name>/` for its type dependencies. */
  prefix: string;
}

export interface LocateInput {
  /** Extracted repository root. */
  repoDir: string;
  /** JS project root inside the repo ("." or a subdirectory with its own lockfile). */
  projectRoot: string;
  packageName: string;
  /** Where TypeScript should find the installed version: the package itself or its `@types` stand-in. */
  link: { as: string; dir: string };
  /** The installed version and its type dependencies, for declaration keys. */
  roots: PackageRoot[];
  /** Target version's package dir, to check deep imports still resolve. */
  targetDir?: string;
  /** Declaration keys worth reporting (changed symbols, their parents for object literals). */
  declKeys: ReadonlySet<string>;
  /** Identifier names the changes mention; files without any of them are not walked. */
  names: ReadonlySet<string>;
}

export interface Hit extends CallSite {
  declKey: string;
  /** Arguments at the call, for arity changes. */
  argCount?: number;
  /** Keyword arguments the call passes (Python). */
  kwargs?: string[];
  /** Property names an object literal of a changed type spells out. */
  props?: string[];
}

export interface ImportUse {
  file: string;
  line: number;
  column: number;
  specifier: string;
  subpath: string;
  existsBefore: boolean;
  existsAfter: boolean | null;
}

export interface LocateResult {
  hits: Hit[];
  imports: ImportUse[];
  coverage: Coverage;
  ms: number;
}

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  "vendor",
  ".turbo",
]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 20_000;

function listSources(root: string, skipped: Map<string, number>) {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FILES) {
        skipped.set("over the file cap", (skipped.get("over the file cap") ?? 0) + 1);
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        if (lstatSync(full).size > MAX_FILE_BYTES)
          skipped.set("larger than 1 MB", (skipped.get("larger than 1 MB") ?? 0) + 1);
        else out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Places the installed version where TypeScript's resolver looks, unless the repo already has it. */
function linkPackage(repoDir: string, link: LocateInput["link"]) {
  const target = join(repoDir, "node_modules", link.as);
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(link.dir, target, "dir");
}

export function locateTs(input: LocateInput): LocateResult {
  const started = Date.now();
  const repoDir = realpathSync(input.repoDir);
  const projectDir = join(repoDir, input.projectRoot === "." ? "" : input.projectRoot);
  const skipped = new Map<string, number>();
  const files = listSources(projectDir, skipped);
  linkPackage(repoDir, input.link);

  const pkg = escapeRegExp(input.packageName);
  const importRe = new RegExp(`["'\`]${pkg}(?:/[^"'\`]*)?["'\`]`);
  const names = [...input.names].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  const nameRe = names.length ? new RegExp(`\\b(?:${names.map(escapeRegExp).join("|")})\\b`) : null;
  const walkSet = new Set(
    files.filter((f) => {
      const text = readFileSync(f, "utf8");
      return importRe.test(text) || (nameRe?.test(text) ?? false);
    }),
  );

  const tsconfig = join(projectDir, "tsconfig.json");
  const overrides: ts.CompilerOptions = {
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    checkJs: false,
    types: [],
    typeRoots: [],
    composite: false,
    incremental: false,
    declaration: false,
  };
  const project = existsSync(tsconfig)
    ? new Project({
        tsConfigFilePath: tsconfig,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: overrides,
      })
    : new Project({
        compilerOptions: {
          ...overrides,
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          jsx: ts.JsxEmit.Preserve,
        },
      });
  for (const f of files) project.addSourceFileAtPath(f);
  const checker = project.getTypeChecker().compilerObject;

  const roots = input.roots
    .map((r) => ({ dir: realpathSync(r.dir).split(sep).join("/"), prefix: r.prefix }))
    .sort((a, b) => b.dir.length - a.dir.length);
  const declKeyOf = (sym: ts.Symbol): string | null => {
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl) return null;
    const file = decl.getSourceFile().fileName.split(sep).join("/");
    const root = roots.find((r) => file.startsWith(`${r.dir}/`));
    if (!root) return null;
    const rel = `${root.prefix}${file.slice(root.dir.length + 1)}`.replace(/\.d\.[cm]?ts$/, "");
    let qualified = sym.getName();
    try {
      qualified = checker.getFullyQualifiedName(sym).replace(/^"[^"]*"\.?/, "") || sym.getName();
    } catch {
      // bare name
    }
    return `${rel}#${qualified}`;
  };
  const resolve = (sym: ts.Symbol | undefined) => {
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      try {
        return checker.getAliasedSymbol(sym);
      } catch {
        return sym;
      }
    }
    return sym;
  };

  const hits: Hit[] = [];
  const imports: ImportUse[] = [];
  const seen = new Set<string>();
  let unresolved = 0;
  const fromManifest = readManifest(input.link.dir) ?? {};
  const toManifest = input.targetDir ? (readManifest(input.targetDir) ?? {}) : null;

  for (const sourceFile of project.getSourceFiles()) {
    const abs = sourceFile.getFilePath();
    if (!walkSet.has(abs)) continue;
    const file = relative(repoDir, abs).split(sep).join("/");
    const lines = sourceFile.getFullText().split("\n");
    const site = (node: Node) => {
      const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
      return { line, column, snippet: (lines[line - 1] ?? "").trim().slice(0, 200) };
    };
    const record = (node: Node, declKey: string, kind: CallSite["kind"], extra: Partial<Hit> = {}) => {
      const at = site(node);
      const key = `${file}:${at.line}:${declKey}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ file, ...at, kind, resolution: "type", declKey, ...extra });
    };

    sourceFile.forEachDescendant((node) => {
      // Import specifiers: deep subpaths must still exist in the target.
      if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
        const spec = node.getLiteralText();
        const parent = node.getParent();
        const isImport =
          Node.isImportDeclaration(parent) ||
          Node.isExportDeclaration(parent) ||
          (Node.isCallExpression(parent) &&
            (parent.getExpression().getText() === "require" ||
              parent.getExpression().getKind() === ts.SyntaxKind.ImportKeyword)) ||
          (Node.isLiteralTypeNode(parent) && Node.isImportTypeNode(parent.getParent()));
        if (isImport && (spec === input.packageName || spec.startsWith(`${input.packageName}/`))) {
          const subpath = spec === input.packageName ? "." : `./${spec.slice(input.packageName.length + 1)}`;
          const at = site(node);
          imports.push({
            file,
            line: at.line,
            column: at.column,
            specifier: spec,
            subpath,
            existsBefore: resolveSubpath(input.link.dir, fromManifest, subpath) !== null,
            existsAfter:
              input.targetDir && toManifest
                ? resolveSubpath(input.targetDir, toManifest, subpath) !== null
                : null,
          });
        }
        return;
      }

      // Object literals of a changed type: which properties the repo spells out.
      if (Node.isObjectLiteralExpression(node)) {
        const contextual = checker.getContextualType(node.compilerNode);
        const sym = contextual && checker.getApparentType(checker.getNonNullableType(contextual)).getSymbol();
        const key = sym && declKeyOf(sym);
        if (key && input.declKeys.has(key)) {
          const props = node
            .getProperties()
            .map((p) =>
              Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p) ? p.getName() : null,
            )
            .filter((n): n is string => n !== null);
          record(node, key, "object", { props });
        }
        return;
      }

      if (!Node.isIdentifier(node) || !input.names.has(node.getText())) return;
      const parent = node.getParent();
      let sym: ts.Symbol | undefined;
      if (
        (Node.isPropertyAssignment(parent) || Node.isShorthandPropertyAssignment(parent)) &&
        parent.getNameNode() === node
      ) {
        // `{ httpAgent: … }`: the property of the type the literal is checked against.
        const literal = parent.getParent();
        const contextual =
          Node.isObjectLiteralExpression(literal) && checker.getContextualType(literal.compilerNode);
        if (contextual)
          sym = checker.getApparentType(checker.getNonNullableType(contextual)).getProperty(node.getText());
      } else {
        sym = resolve(checker.getSymbolAtLocation(node.compilerNode));
      }
      if (!sym) {
        // `x.parse` on an `any`-typed value: the compiler cannot say whose it is.
        if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) {
          const left = checker.getTypeAtLocation(parent.getExpression().compilerNode);
          if (left.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) unresolved++;
        }
        return;
      }
      const key = declKeyOf(sym);
      if (!key || !input.declKeys.has(key)) return;
      const call = parent && Node.isPropertyAccessExpression(parent) ? parent.getParent() : parent;
      if (
        call &&
        Node.isCallExpression(call) &&
        (call.getExpression() === parent || call.getExpression() === node)
      )
        record(node, key, "call", { argCount: call.getArguments().length });
      else if (call && Node.isNewExpression(call))
        record(node, key, "new", { argCount: call.getArguments()?.length ?? 0 });
      else if (Node.isTypeReference(parent) || Node.isQualifiedName(parent)) record(node, key, "type-ref");
      else if (Node.isImportSpecifier(parent) || Node.isImportClause(parent)) record(node, key, "import");
      else record(node, key, "property");
    });
  }

  // Type-level only when the package's own imports resolve to the linked files.
  let importsTotal = 0;
  let importsResolved = 0;
  for (const sf of project.getSourceFiles()) {
    if (!walkSet.has(sf.getFilePath())) continue;
    for (const d of sf.getImportDeclarations()) {
      const spec = d.getModuleSpecifierValue();
      if (spec !== input.packageName && !spec.startsWith(`${input.packageName}/`)) continue;
      importsTotal++;
      const target = d.getModuleSpecifierSourceFile()?.getFilePath().split(sep).join("/");
      if (target && roots.some((r) => target.startsWith(`${r.dir}/`))) importsResolved++;
    }
  }
  return {
    hits,
    imports,
    ms: Date.now() - started,
    coverage: {
      filesScanned: files.length,
      filesSkipped: [...skipped].map(([reason, count]) => ({ reason, count })),
      languages: [...new Set(files.map((f) => (/\.(c|m)?tsx?$/.test(f) ? "ts" : "js")))].sort(),
      resolutionLevel: importsTotal === 0 || importsResolved > 0 ? "type" : "syntax",
      unresolvedSites: unresolved,
      transitiveAnalysed: false,
    },
  };
}
