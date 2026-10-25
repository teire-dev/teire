import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CallNode, loadPrism, type Node, Visitor } from "@ruby/prism";
import type { RepoTree } from "../inventory/tree";
import type { Hit, ImportUse, LocateResult } from "./ts";

/**
 * Ruby uses of a gem's changed API (plan S07, research ruby.md Job 5), with Prism in the worker:
 *  - constant references resolved as written (`Faraday::Request::Retry`, `Faraday::Response::Middleware`);
 *  - `require "faraday/autoload"` of a removed path (an import, matched by its `require:` specifier);
 *  - `require "multipart/post"` of a gem the new version no longer depends on (`gem:` keys);
 *  - calls of a changed method, in files that reference the gem's top-level constant (name-only:
 *    Ruby is untyped, so a receiver's class is not known). Each call carries the keyword names it
 *    passes, so a removed keyword matches only the calls that pass it (`create(payment_method_types: …)`).
 * The sandbox's tests are the authority; a located removal is the evidence a PR stands on.
 */
type Parse = Awaited<ReturnType<typeof loadPrism>>;

/**
 * Methods every Ruby object or class answers (BasicObject, Object, Kernel, Module, Class,
 * Comparable, Enumerable): a gem removing its own `new`, `call` or `dup` says nothing about a
 * `.new` call whose receiver Teire cannot type.
 */
const CORE = new Set(
  (
    "new allocate initialize superclass class singleton_class instance_of? kind_of? is_a? respond_to? send public_send __send__ " +
    "method methods public_method instance_variable_get instance_variable_set instance_variables object_id equal? eql? hash " +
    "== != ! === =~ <=> to_s inspect to_h to_a to_proc to_str to_ary dup clone freeze frozen? tap then yield_self itself " +
    "display extend define_singleton_method instance_exec instance_eval class_eval module_eval class_exec module_exec " +
    "define_method attr_reader attr_writer attr_accessor include prepend name const_get const_set constants ancestors " +
    "instance_method instance_methods private public protected module_function nil? puts print p require load raise " +
    "loop lambda proc format sprintf sleep each map select reject find each_with_index each_with_object inject reduce " +
    "sort sort_by min max sum count first include? to_set zip group_by partition flat_map call [] []= < > <= >= between? clamp"
  ).split(" "),
);
let parser: Promise<Parse> | null = null;

type Loc = { location: { startOffset: number } };
type Str = { unescaped?: { value?: string } | string };
const text = (s: Str | undefined) => (typeof s?.unescaped === "string" ? s.unescaped : s?.unescaped?.value);

function constPath(node: Node | null): string | null {
  const n = node as unknown as { constructor: { name: string }; name?: string; parent?: Node | null } | null;
  if (!n) return null;
  if (n.constructor.name === "ConstantReadNode") return n.name ?? null;
  if (n.constructor.name === "ConstantPathNode") {
    const parent = n.parent ? constPath(n.parent) : null;
    return parent ? `${parent}::${n.name}` : (n.name ?? null);
  }
  return null;
}

function argsOf(node: CallNode): Node[] {
  return (node.arguments_ as unknown as { arguments_?: Node[] } | null)?.arguments_ ?? [];
}

export async function locateRuby(input: {
  repoDir: string;
  tree: RepoTree;
  projectRoot: string;
  /** Top-level constants the gem defines (`Faraday`), from the old version's surface. */
  roots: string[];
  declKeys: ReadonlySet<string>;
  /** Method names the new version still defines: a by-name match on them alone is ambiguous. */
  keptMethodNames?: ReadonlySet<string>;
}): Promise<LocateResult> {
  const started = Date.now();
  parser ??= loadPrism();
  const parse = await parser;
  const prefix = input.projectRoot === "." ? "" : `${input.projectRoot}/`;
  const files = input.tree
    .files()
    .filter(
      (f) =>
        /\.(?:rb|rake|ru)$/.test(f) &&
        f.startsWith(prefix) &&
        !/(?:^|\/)(?:vendor|node_modules|tmp|log)\//.test(f),
    );
  const keys = [...input.declKeys];
  const special = (k: string) => /^(?:require|gem):/.test(k);
  const constants = keys.filter((k) => !k.includes("#") && !k.includes(".") && !special(k));
  const requires = new Set(keys.filter((k) => k.startsWith("require:")).map((k) => k.slice(8)));
  // A dropped runtime dependency is used through its require path: the gem name, or with `-` as `/`.
  const gems = keys
    .filter((k) => k.startsWith("gem:"))
    .map((k) => k.slice(4))
    .map((g) => ({ key: `gem:${g}`, paths: [g, g.replace(/-/g, "/"), g.replace(/-/g, "_")] }));
  // `Faraday::Connection#basic_auth` → method name `basic_auth` and its owner.
  const methods = keys
    .filter((k) => /[#.]/.test(k) && !special(k))
    .map((k) => {
      const at = Math.max(k.lastIndexOf("#"), k.lastIndexOf("."));
      return { key: k, owner: k.slice(0, at), name: k.slice(at + 1), singleton: k[at] === "." };
    });
  const hits: Hit[] = [];
  const imports: ImportUse[] = [];
  let parseErrors = 0;
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(input.repoDir, file), "utf8");
    } catch {
      continue;
    }
    if (!input.roots.some((r) => source.includes(r)) && !source.includes("require")) continue;
    const result = parse(source);
    if (result.errors.length) parseErrors++;
    const bytes = Buffer.from(source);
    const starts = [0];
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) starts.push(i + 1);
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
    const lines = source.split("\n");
    const usesGem = input.roots.some((r) => new RegExp(`\\b${r}\\b`).test(source));
    const add = (
      offset: number,
      kind: Hit["kind"],
      declKey: string,
      resolution: Hit["resolution"],
      kwargs?: string[],
    ) => {
      const { line, column } = lineOf(offset);
      if (hits.some((h) => h.file === file && h.line === line && h.declKey === declKey)) return;
      hits.push({
        file,
        line,
        column,
        kind,
        snippet: (lines[line - 1] ?? "").trim().slice(0, 200),
        resolution,
        declKey,
        ...(kwargs ? { kwargs } : {}),
      });
    };
    const required = (offset: number, specifier: string, subpath: string) => {
      const { line, column } = lineOf(offset);
      imports.push({ file, line, column, specifier, subpath, existsBefore: true, existsAfter: false });
    };
    class Finder extends Visitor {
      override visitConstantPathNode(node: Node) {
        const path = constPath(node);
        if (path && constants.includes(path))
          add((node as unknown as Loc).location.startOffset, "type-ref", path, "import");
        else super.visitConstantPathNode(node as never);
      }
      override visitConstantReadNode(node: Node) {
        const name = (node as unknown as { name: string }).name;
        if (constants.includes(name))
          add((node as unknown as Loc).location.startOffset, "type-ref", name, "import");
      }
      override visitCallNode(node: CallNode) {
        const offset = node.location.startOffset;
        if (node.name === "require" && !node.receiver) {
          const value = text(argsOf(node)[0] as unknown as Str);
          if (value) {
            if (requires.has(value)) required(offset, `require:${value}`, value);
            for (const g of gems)
              if (g.paths.some((p) => value === p || value.startsWith(`${p}/`)))
                required(offset, g.key, value);
          }
        }
        if (usesGem)
          for (const m of methods) {
            if (m.name !== node.name) continue;
            const receiver = constPath(node.receiver);
            // `Faraday.default_connection` with the owner as receiver is resolved; anything else is by name.
            if (m.singleton && receiver && receiver !== m.owner) continue;
            const resolved = m.singleton && receiver === m.owner;
            // By name alone, a name other classes still answer to is not evidence of a use.
            if (!resolved && (CORE.has(m.name) || input.keptMethodNames?.has(m.name))) continue;
            const kwargs = argsOf(node).flatMap((a) =>
              ((a as unknown as { elements?: { key?: Str }[] }).elements ?? []).map((e) => text(e.key) ?? ""),
            );
            add(offset, "call", m.key, resolved ? "import" : "name-only", kwargs.filter(Boolean));
          }
        super.visitCallNode(node);
      }
    }
    result.value.accept(new Finder());
  }
  return {
    hits,
    imports,
    ms: Date.now() - started,
    coverage: {
      filesScanned: files.length,
      filesSkipped: parseErrors ? [{ reason: "Ruby parse errors", count: parseErrors }] : [],
      languages: ["ruby"],
      resolutionLevel: "syntax",
      unresolvedSites: 0,
      transitiveAnalysed: false,
    },
  };
}
