import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CallNode, loadPrism, type Node, Visitor } from "@ruby/prism";
import type { RepoTree } from "../inventory/tree";
import type { Hit, LocateResult } from "./ts";

/**
 * Ruby uses of a gem's changed API (plan S07, research ruby.md Job 5), with Prism in the worker:
 *  - constant references resolved as written (`Faraday::Request::Retry`, `Faraday::Response::Middleware`);
 *  - `require "faraday/autoload"` of a removed path;
 *  - calls of a removed method, in files that reference the gem's top-level constant (name-only:
 *    Ruby is untyped, so a receiver's class is not known);
 *  - calls passing a removed keyword (`create(payment_method_types: …)`).
 * The sandbox's tests are the authority; a located removal is the evidence a PR stands on.
 */
type Parse = Awaited<ReturnType<typeof loadPrism>>;
let parser: Promise<Parse> | null = null;

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

export async function locateRuby(input: {
  repoDir: string;
  tree: RepoTree;
  projectRoot: string;
  /** Top-level constants the gem defines (`Faraday`), from the old version's surface. */
  roots: string[];
  declKeys: ReadonlySet<string>;
  /** Removed keyword parameters: method key → keyword names. */
  removedKeywords?: Map<string, string[]>;
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
  const constants = keys.filter((k) => !k.includes("#") && !k.includes(".") && !k.startsWith("require:"));
  const requires = new Set(keys.filter((k) => k.startsWith("require:")).map((k) => k.slice(8)));
  // `Faraday::Connection#basic_auth` → method name `basic_auth` and its owner.
  const methods = keys
    .filter((k) => /[#.]/.test(k) && !k.startsWith("require:"))
    .map((k) => {
      const at = Math.max(k.lastIndexOf("#"), k.lastIndexOf("."));
      return { key: k, owner: k.slice(0, at), name: k.slice(at + 1), singleton: k[at] === "." };
    });
  const hits: Hit[] = [];
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
    const add = (offset: number, kind: Hit["kind"], declKey: string, resolution: Hit["resolution"]) => {
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
      });
    };
    class Finder extends Visitor {
      override visitConstantPathNode(node: Node) {
        const path = constPath(node);
        if (path && constants.includes(path))
          add(
            (node as unknown as { location: { startOffset: number } }).location.startOffset,
            "type-ref",
            path,
            "import",
          );
        else super.visitConstantPathNode(node as never);
      }
      override visitConstantReadNode(node: Node) {
        const name = (node as unknown as { name: string }).name;
        if (constants.includes(name))
          add(
            (node as unknown as { location: { startOffset: number } }).location.startOffset,
            "type-ref",
            name,
            "import",
          );
      }
      override visitCallNode(node: CallNode) {
        const offset = node.location.startOffset;
        if (node.name === "require" && !node.receiver) {
          const arg = (
            node.arguments_ as unknown as { arguments?: { unescaped?: { value?: string } | string }[] } | null
          )?.arguments?.[0];
          const value = typeof arg?.unescaped === "string" ? arg.unescaped : arg?.unescaped?.value;
          if (value && requires.has(value)) add(offset, "import", `require:${value}`, "import");
        }
        if (usesGem)
          for (const m of methods) {
            if (m.name !== node.name) continue;
            const receiver = constPath(node.receiver);
            // `Faraday.default_connection` with the owner as receiver is resolved; anything else is by name.
            if (m.singleton && receiver && receiver !== m.owner) continue;
            // A removed keyword breaks only the calls that pass it.
            const removed = input.removedKeywords?.get(m.key) ?? [];
            if (removed.length) {
              const args = (node.arguments_ as unknown as { arguments?: Node[] } | null)?.arguments ?? [];
              const passes = args.some((a) =>
                (
                  (a as unknown as { elements?: { key?: { unescaped?: { value?: string } | string } }[] })
                    .elements ?? []
                ).some((e) => {
                  const k = e.key?.unescaped;
                  return removed.includes(typeof k === "string" ? k : (k?.value ?? ""));
                }),
              );
              if (!passes) continue;
            }
            add(offset, "call", m.key, m.singleton && receiver === m.owner ? "import" : "name-only");
          }
        super.visitCallNode(node);
      }
    }
    result.value.accept(new Finder());
  }
  return {
    hits,
    imports: [],
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
