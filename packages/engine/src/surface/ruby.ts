import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  type CallNode,
  type ClassNode,
  type ConstantWriteNode,
  type DefNode,
  loadPrism,
  type ModuleNode,
  type Node,
  type ParametersNode,
  type SingletonClassNode,
  Visitor,
} from "@ruby/prism";
import { RUBY, SURFACE } from "../constants";
import { extractTarGz } from "../inventory/archive";
import { guardedFetch } from "../net/fetch";
import { gemVersionDetail } from "../registry/rubygems";
import type { SurfaceChange, SurfaceDiff } from "./types";

/**
 * Ruby API-surface diff (plan S07, D57; research ruby.md Job 4): Ruby has no standard tool, so Teire
 * reads every `.rb` file under `lib/` of both published `.gem` files with Prism (WASM, no Ruby, no gem code runs)
 * and compares the public surface. It sees classes, modules and constants (Struct.new/Data.define
 * included), methods from def, attr_reader/writer/accessor, alias, define_method(:literal) and delegators, visibility, and
 * parameter shapes. It cannot see methods generated with computed names or method_missing APIs, so
 * a removal it reports is confirmed only with a changelog quote (plan S07); otherwise candidate.
 */
interface Params {
  req: number;
  opt: number;
  rest: boolean;
  post: number;
  kwReq: string[];
  kwOpt: string[];
  kwRest: boolean;
}

export interface RubySymbol {
  key: string;
  kind: "module" | "class" | "constant" | "method";
  visibility: "public" | "private" | "protected";
  params?: Params;
  where: string;
}

export interface RubySurface {
  symbols: Map<string, RubySymbol>;
  requirePaths: Set<string>;
  files: number;
  parseErrors: number;
}

type Parse = Awaited<ReturnType<typeof loadPrism>>;
let parser: Promise<Parse> | null = null;
const prism = () => {
  parser ??= loadPrism();
  return parser;
};

function constName(node: Node | null): string | null {
  if (!node) return null;
  const n = node as unknown as { constructor: { name: string }; name?: string; parent?: Node | null };
  if (n.constructor.name === "ConstantReadNode") return n.name ?? null;
  if (n.constructor.name === "ConstantPathNode") {
    const parent = n.parent ? constName(n.parent) : null;
    return parent ? `${parent}::${n.name}` : (n.name ?? null);
  }
  return null;
}

function paramsOf(p: ParametersNode | null): Params {
  const kw = (p?.keywords ?? []) as unknown as { constructor: { name: string }; name: string }[];
  // `def x(a, ...)` forwards every argument: positionals and keywords alike.
  const forwards =
    (p?.keywordRest as unknown as { constructor: { name: string } } | null)?.constructor.name ===
    "ForwardingParameterNode";
  return {
    req: p?.requireds.length ?? 0,
    opt: p?.optionals.length ?? 0,
    rest: !!p?.rest || forwards,
    post: p?.posts.length ?? 0,
    kwReq: kw.filter((k) => k.constructor.name === "RequiredKeywordParameterNode").map((k) => k.name),
    kwOpt: kw.filter((k) => k.constructor.name === "OptionalKeywordParameterNode").map((k) => k.name),
    kwRest: !!p?.keywordRest,
  };
}

/** Literal symbol or string arguments of a call (`attr_reader :a, :b`, `private :x`). */
function literalArgs(call: CallNode): string[] {
  const args = (call.arguments_ as unknown as { arguments_?: Node[] } | null)?.arguments_ ?? [];
  return args.flatMap((a) => {
    const n = a as unknown as { constructor: { name: string }; unescaped?: { value?: string } | string };
    if (n.constructor.name !== "SymbolNode" && n.constructor.name !== "StringNode") return [];
    const u = n.unescaped;
    const v = typeof u === "string" ? u : u?.value;
    return v ? [v] : [];
  });
}

class Extractor extends Visitor {
  namespace: string[] = [];
  singleton = 0;
  visibility: ("public" | "private" | "protected")[] = ["public"];
  symbols = new Map<string, RubySymbol>();
  constructor(
    private file: string,
    private line: (offset: number) => number,
  ) {
    super();
  }
  ns() {
    return this.namespace.join("::");
  }
  add(sym: Omit<RubySymbol, "where">, offset: number) {
    if (!sym.key || this.symbols.has(sym.key)) return;
    this.symbols.set(sym.key, { ...sym, where: `${this.file}:${this.line(offset)}` });
  }
  method(
    name: string,
    singleton: boolean,
    params: Params | undefined,
    offset: number,
    visibility = this.visibility.at(-1) ?? "public",
  ) {
    const ns = this.ns() || "Object";
    this.add(
      {
        key: `${ns}${singleton ? "." : "#"}${name}`,
        kind: "method",
        visibility,
        ...(params ? { params } : {}),
      },
      offset,
    );
  }
  enter(name: string, kind: "module" | "class", offset: number, body: Node | null) {
    const parts = name.split("::");
    this.namespace.push(...parts);
    this.add({ key: this.ns(), kind, visibility: "public" }, offset);
    this.visibility.push("public");
    if (body) this.visit(body);
    this.visibility.pop();
    this.namespace.splice(this.namespace.length - parts.length, parts.length);
  }
  override visitModuleNode(node: ModuleNode) {
    const name = constName(node.constantPath);
    if (name) this.enter(name, "module", node.location.startOffset, node.body);
  }
  override visitClassNode(node: ClassNode) {
    const name = constName(node.constantPath);
    if (!name) return;
    this.enter(name, "class", node.location.startOffset, node.body);
    // `class X < Struct.new(:a, :b)`: the members are accessors.
    const sup = node.superclass as unknown as CallNode | null;
    if (
      sup &&
      (sup as unknown as { constructor: { name: string } }).constructor.name === "CallNode" &&
      /^(new|define)$/.test(sup.name)
    )
      for (const m of literalArgs(sup)) {
        this.namespace.push(...name.split("::"));
        this.method(m, false, undefined, node.location.startOffset, "public");
        this.namespace.splice(this.namespace.length - name.split("::").length);
      }
  }
  override visitSingletonClassNode(node: SingletonClassNode) {
    this.singleton++;
    this.visibility.push("public");
    if (node.body) this.visit(node.body);
    this.visibility.pop();
    this.singleton--;
  }
  override visitDefNode(node: DefNode) {
    const singleton = !!node.receiver || this.singleton > 0;
    this.method(node.name, singleton, paramsOf(node.parameters), node.location.startOffset);
  }
  override visitConstantWriteNode(node: ConstantWriteNode) {
    const key = this.ns() ? `${this.ns()}::${node.name}` : node.name;
    const value = node.value as unknown as CallNode;
    const isStruct =
      (value as unknown as { constructor: { name: string } }).constructor.name === "CallNode" &&
      /^(new|define)$/.test(value.name);
    this.add({ key, kind: isStruct ? "class" : "constant", visibility: "public" }, node.location.startOffset);
    if (isStruct) {
      this.namespace.push(node.name);
      for (const m of literalArgs(value))
        this.method(m, false, undefined, node.location.startOffset, "public");
      // `X = Struct.new(:a) do … end` / `Class.new(Base) do … end`: the block is the class body.
      const block = (value as unknown as { block?: { body?: Node | null } | null }).block;
      if (block?.body) {
        this.visibility.push("public");
        this.visit(block.body);
        this.visibility.pop();
      }
      this.namespace.pop();
    }
  }
  override visitCallNode(node: CallNode) {
    const args = literalArgs(node);
    const offset = node.location.startOffset;
    if (!node.receiver)
      switch (node.name) {
        case "private":
        case "protected":
        case "public":
          if (!args.length && !node.arguments_) this.visibility[this.visibility.length - 1] = node.name;
          else
            for (const a of args) {
              const key = `${this.ns() || "Object"}#${a}`;
              const sym = this.symbols.get(key);
              if (sym) sym.visibility = node.name;
            }
          return;
        case "private_class_method":
          for (const a of args) {
            const sym = this.symbols.get(`${this.ns()}.${a}`);
            if (sym) sym.visibility = "private";
          }
          return;
        case "private_constant":
          for (const a of args) {
            const sym = this.symbols.get(`${this.ns()}::${a}`);
            if (sym) sym.visibility = "private";
          }
          return;
        case "attr_reader":
        case "attr_writer":
        case "attr_accessor":
          for (const a of args) {
            if (node.name !== "attr_writer") this.method(a, this.singleton > 0, undefined, offset);
            if (node.name !== "attr_reader") this.method(`${a}=`, this.singleton > 0, undefined, offset);
          }
          return;
        case "alias_method":
        case "define_method":
          if (args[0]) this.method(args[0], this.singleton > 0, undefined, offset);
          return;
        case "def_delegators":
        case "delegate":
          for (const a of node.name === "def_delegators" ? args.slice(1) : args)
            this.method(a, false, undefined, offset);
          return;
        case "def_delegator":
          if (args[2] ?? args[1]) this.method((args[2] ?? args[1]) as string, false, undefined, offset);
          return;
      }
    super.visitCallNode(node);
  }
}

export async function rubySurface(libDir: string): Promise<RubySurface> {
  const parse = await prism();
  const symbols = new Map<string, RubySymbol>();
  const requirePaths = new Set<string>();
  let files = 0;
  let parseErrors = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir).catch(() => [])) {
      const path = join(dir, entry);
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(path);
      else if (entry.endsWith(".rb") && st.size < RUBY.maxFileBytes) {
        const rel = relative(libDir, path);
        requirePaths.add(rel.replace(/\.rb$/, ""));
        const source = await readFile(path);
        const result = parse(source.toString("utf8"));
        files++;
        if (result.errors.length) parseErrors++;
        const starts = [0];
        for (let i = 0; i < source.length; i++) if (source[i] === 10) starts.push(i + 1);
        const line = (offset: number) => {
          let lo = 0;
          let hi = starts.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if ((starts[mid] ?? 0) <= offset) lo = mid;
            else hi = mid - 1;
          }
          return lo + 1;
        };
        const x = new Extractor(rel, line);
        result.value.accept(x);
        for (const [k, v] of x.symbols) if (!symbols.has(k)) symbols.set(k, v);
      }
    }
  };
  await walk(libDir);
  return { symbols, requirePaths, files, parseErrors };
}

/** Signature changes that break existing callers (research ruby.md, prototype rules). */
export function signatureBreaks(a: Params, b: Params): { why: string[]; removedKeywords: string[] } {
  const why: string[] = [];
  if (b.req + b.post > a.req + a.post) why.push("more required positional parameters");
  const maxA = a.rest ? Number.POSITIVE_INFINITY : a.req + a.opt + a.post;
  const maxB = b.rest ? Number.POSITIVE_INFINITY : b.req + b.opt + b.post;
  if (maxB < maxA) why.push("fewer positional parameters accepted");
  const newRequired = b.kwReq.filter((k) => !a.kwReq.includes(k));
  if (newRequired.length) why.push(`new required keyword ${newRequired.join(", ")}`);
  const removedKeywords = b.kwRest
    ? []
    : [...a.kwReq, ...a.kwOpt].filter((k) => !b.kwReq.includes(k) && !b.kwOpt.includes(k));
  if (removedKeywords.length) why.push(`keyword ${removedKeywords.join(", ")} removed`);
  if (a.kwRest && !b.kwRest) why.push("**options no longer accepted");
  return { why, removedKeywords };
}

export function diffRubySurfaces(before: RubySurface, after: RubySurface): SurfaceChange[] {
  const out: SurfaceChange[] = [];
  for (const path of before.requirePaths)
    if (!after.requirePaths.has(path))
      out.push({
        path: `require:${path}`,
        declKey: `require:${path}`,
        kind: "entry-removed",
        severity: "breaking",
        before: path,
        after: null,
      });
  for (const [key, a] of before.symbols) {
    if (a.visibility !== "public") continue;
    const b = after.symbols.get(key);
    const kind = a.kind === "method" ? "method" : a.kind === "constant" ? "variable" : a.kind;
    if (!b || b.visibility !== "public") {
      out.push({
        path: key,
        declKey: key,
        kind: "removed",
        symbolKind: kind,
        severity: "breaking",
        before: a.where,
        after: b ? `now ${b.visibility}` : null,
      });
      continue;
    }
    if (a.params && b.params) {
      const { why, removedKeywords } = signatureBreaks(a.params, b.params);
      if (removedKeywords.length)
        for (const k of removedKeywords)
          out.push({
            path: key,
            declKey: key,
            kind: "parameter-removed",
            symbolKind: "method",
            severity: "breaking",
            before: a.where,
            after: b.where,
            param: k,
          });
      const other = why.filter((w) => !w.startsWith("keyword "));
      if (other.length)
        out.push({
          path: key,
          declKey: key,
          // A new required keyword breaks every call that does not pass it: an arity change.
          kind: "arity-changed",
          symbolKind: "method",
          severity: "breaking",
          before: a.where,
          after: b.where,
          guidance: other.join("; "),
        });
    }
  }
  return out;
}

/** A `.gem` is a plain tar holding `data.tar.gz`; its sha256 is checked against the registry's. */
async function fetchGemLib(name: string, version: string, into: string) {
  const res = await guardedFetch(
    `https://rubygems.org/downloads/${encodeURIComponent(name)}-${version}.gem`,
    {
      allowHosts: ["rubygems.org", "index.rubygems.org", ".rubygems.org"],
      maxBytes: RUBY.maxGemBytes,
      timeoutMs: 120_000,
    },
  );
  if (res.status !== 200) throw new Error(`gem ${res.status} for ${name}-${version}`);
  const expected = (await gemVersionDetail(name, version))?.sha ?? undefined;
  const actual = createHash("sha256").update(res.body).digest("hex");
  if (expected && expected !== actual) throw new Error(`sha256 mismatch for ${name}-${version}.gem`);
  // Outer tar: find data.tar.gz (512-byte headers, size in octal).
  let off = 0;
  const body = res.body;
  while (off + 512 <= body.length) {
    const header = body.subarray(off, off + 512);
    const entry = Buffer.from(header.subarray(0, 100)).toString("utf8").replace(/\0.*$/s, "");
    if (!entry) break;
    const size = Number.parseInt(
      Buffer.from(header.subarray(124, 136)).toString("utf8").replace(/\0.*$/s, "").trim() || "0",
      8,
    );
    const start = off + 512;
    if (entry === "data.tar.gz") {
      await mkdir(into, { recursive: true });
      // Gem data has no top directory (unlike a GitHub tarball): nothing to strip.
      await extractTarGz(body.subarray(start, start + size), into, { stripComponents: 0 });
      return join(into, "lib");
    }
    off = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${name}-${version}.gem has no data.tar.gz`);
}

export async function rubySurfaceDiff(name: string, from: string, to: string): Promise<SurfaceDiff> {
  const started = Date.now();
  const scratch = await mkdtemp(join(tmpdir(), "teire-gem-"));
  const notes: string[] = [];
  let changes: SurfaceChange[] = [];
  let unanalyzable = false;
  let sizes = { a: 0, b: 0 };
  let kept: string[] = [];
  try {
    const [libA, libB] = await Promise.all([
      fetchGemLib(name, from, join(scratch, "a")),
      fetchGemLib(name, to, join(scratch, "b")),
    ]);
    const [a, b] = await Promise.all([rubySurface(libA), rubySurface(libB)]);
    sizes = { a: a.symbols.size, b: b.symbols.size };
    kept = [...new Set([...b.symbols.keys()].flatMap((k) => /[#.]([^#.:]+)$/.exec(k)?.[1] ?? []))];
    changes = diffRubySurfaces(a, b);
    // Runtime dependencies the new version dropped: code that requires them loses them (registry data).
    const [da, db] = await Promise.all([gemVersionDetail(name, from), gemVersionDetail(name, to)]);
    for (const dep of da?.runtime ?? [])
      if (db && !db.runtime.some((d) => d.name === dep.name))
        changes.push({
          path: `gem:${dep.name}`,
          declKey: `gem:${dep.name}`,
          kind: "entry-removed",
          severity: "breaking",
          before: `${dep.name} ${dep.requirements}`,
          after: null,
          guidance: `${name} ${to} no longer depends on ${dep.name}: code that requires it needs its own Gemfile entry`,
        });
    notes.push(
      `Prism extractor over lib/ (${a.files}/${b.files} files, ${a.symbols.size}/${b.symbols.size} symbols${a.parseErrors + b.parseErrors ? `, ${a.parseErrors + b.parseErrors} files with parse errors` : ""}); methods generated at runtime are not seen`,
    );
  } catch (error) {
    unanalyzable = true;
    notes.push(
      `gem comparison failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const counts: SurfaceDiff["counts"] = {};
  for (const c of changes) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  const side = (n: number) => ({
    source: { kind: "bundled" as const },
    symbols: n,
    truncated: false,
    ms: Date.now() - started,
    integrity: "",
  });
  return {
    ecosystem: "rubygems",
    name,
    fromVersion: from,
    toVersion: to,
    from: side(sizes.a),
    to: side(sizes.b),
    changes,
    counts,
    moved: {},
    unanalyzable,
    notes,
    keptMethodNames: kept,
    tool: {
      name: "teire-prism-surface",
      version: RUBY.extractorVersion,
      noiseFilterVersion: SURFACE.noiseFilterVersion,
    },
  };
}
