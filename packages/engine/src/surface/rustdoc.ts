import { gunzipSync } from "node:zlib";
import { RUST } from "../constants";
import { guardedFetch } from "../net/fetch";

/**
 * docs.rs rustdoc JSON (plan S06): the API-surface diff's input, and the Rust fix agent's
 * `lookup_docs`. The search walks the target version's public module tree, so an answer is the path
 * a user writes (`rand::prelude::IndexedRandom`, a re-export) with the item's signature, its
 * deprecation note and the first line of its docs. A name the target no longer has is looked up in
 * the old version, and target items with the same signature under another name are offered as
 * possible renames (`thread_rng() -> ThreadRng` → `rng() -> ThreadRng`); the compiler decides.
 */
export async function rustdocJson(name: string, version: string) {
  const res = await guardedFetch(`https://docs.rs/crate/${encodeURIComponent(name)}/${version}/json.gz`, {
    allowHosts: ["docs.rs", "static.docs.rs"],
    maxBytes: RUST.maxRustdocBytes,
    timeoutMs: 120_000,
  });
  if (res.status !== 200) return null;
  const text = gunzipSync(res.body).toString("utf8");
  const format = Number(
    /"format_version"\s*:\s*(\d+)/.exec(text.slice(-4096) + text.slice(0, 4096))?.[1] ?? 0,
  );
  return { text, format };
}

type Json = Record<string, unknown> & { [k: string]: unknown };
interface RawItem {
  name?: string | null;
  visibility?: unknown;
  docs?: string | null;
  deprecation?: { since?: string | null; note?: string | null } | null;
  inner: Record<string, Json>;
}
interface RawDoc {
  root: number | string;
  index: Record<string, RawItem>;
  paths: Record<string, { path: string[]; kind: string }>;
}

export interface DocItem {
  path: string;
  name: string;
  kind: string;
  /** Rendered signature of a function or method, without its name: `(&mut self, range: R) -> T`. */
  sig?: string;
  doc: string;
  deprecated?: string;
  members?: string[];
}

function ty(t: unknown): string {
  if (t === null || t === undefined) return "()";
  if (typeof t === "string") return t === "infer" ? "_" : t;
  const o = t as Json;
  const [kind, v] = Object.entries(o)[0] ?? ["", null];
  const val = v as Json;
  switch (kind) {
    case "primitive":
    case "generic":
      return String(v);
    case "resolved_path": {
      const args = ((val.args as Json | null)?.angle_bracketed as Json | undefined)?.args as
        | Json[]
        | undefined;
      const rendered = (args ?? []).map((a) =>
        "type" in a ? ty(a.type) : "lifetime" in a ? String(a.lifetime) : "_",
      );
      return `${String(val.path ?? val.name)}${rendered.length ? `<${rendered.join(", ")}>` : ""}`;
    }
    case "borrowed_ref":
      return `&${val.lifetime ? `${val.lifetime} ` : ""}${val.is_mutable ? "mut " : ""}${ty(val.type)}`;
    case "raw_pointer":
      return `*${val.is_mutable ? "mut" : "const"} ${ty(val.type)}`;
    case "slice":
      return `[${ty(v)}]`;
    case "array":
      return `[${ty(val.type)}; ${val.len}]`;
    case "tuple":
      return `(${(v as unknown[]).map(ty).join(", ")})`;
    case "impl_trait":
      return `impl ${(v as Json[]).map((b) => String(((b.trait_bound as Json | undefined)?.trait as Json | undefined)?.path ?? "_")).join(" + ")}`;
    case "dyn_trait":
      return `dyn ${((val.traits as Json[]) ?? []).map((b) => String((b.trait as Json | undefined)?.path ?? "_")).join(" + ")}`;
    case "qualified_path":
      return `${ty(val.self_type)}::${val.name}`;
    case "function_pointer":
      return "fn(..)";
    default:
      return "_";
  }
}

function signature(fn: Json) {
  const sig = fn.sig as Json | undefined;
  if (!sig) return undefined;
  const generics = (((fn.generics as Json | undefined)?.params as Json[] | undefined) ?? [])
    .filter((p) => (p.kind as Json | undefined)?.type !== undefined)
    .map((p) => String(p.name));
  const inputs = ((sig.inputs as [string, unknown][]) ?? []).map(([n, t]) => {
    const rendered = ty(t);
    if (n === "self") return rendered === "Self" ? "self" : rendered.replace(/Self$/, "self");
    return `${n}: ${rendered}`;
  });
  return `${generics.length ? `<${generics.join(", ")}>` : ""}(${inputs.join(", ")})${sig.output ? ` -> ${ty(sig.output)}` : ""}`;
}

function firstLine(docs: string | null | undefined) {
  const para = (docs ?? "").split(/\n\s*\n/)[0] ?? "";
  return para.replace(/\s+/g, " ").trim().slice(0, 220);
}

/** Every public path of a crate, from its rustdoc JSON. */
export function rustdocItems(text: string, crate: string): DocItem[] {
  const doc = JSON.parse(text) as RawDoc;
  const out: DocItem[] = [];
  const seen = new Set<string>();
  const add = (item: DocItem) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    out.push(item);
    return true;
  };
  const deprecation = (item: RawItem) =>
    item.deprecation
      ? [item.deprecation.since && `since ${item.deprecation.since}`, item.deprecation.note]
          .filter(Boolean)
          .join(": ") || "deprecated"
      : undefined;
  const visibleIn = (item: RawItem) => item.visibility === "public" || item.visibility === "default";

  const named = (id: string, path: string[], depth: number): void => {
    const item = doc.index[id];
    if (!item || depth > 10) return;
    const [kind, inner] = Object.entries(item.inner)[0] ?? ["", {}];
    const full = path.join("::");
    const base: DocItem = {
      path: full,
      name: path[path.length - 1] ?? "",
      kind,
      doc: firstLine(item.docs),
      ...(deprecation(item) ? { deprecated: deprecation(item) } : {}),
    };
    if (kind === "module") {
      if (!add(base)) return;
      for (const child of ((inner.items as (number | string)[]) ?? []).map(String))
        member(child, path, depth + 1);
      return;
    }
    if (kind === "function") {
      add({ ...base, ...(signature(inner) ? { sig: signature(inner) } : {}) });
      return;
    }
    if (kind === "trait") {
      const methods = ((inner.items as (number | string)[]) ?? [])
        .map(String)
        .map((m) => [m, doc.index[m]] as const);
      add({ ...base, members: methods.map(([, m]) => m?.name ?? "").filter(Boolean) });
      for (const [, m] of methods) {
        const [mk, mi] = Object.entries(m?.inner ?? {})[0] ?? ["", {}];
        if (!m?.name) continue;
        add({
          path: `${full}::${m.name}`,
          name: m.name,
          kind: mk === "function" ? "method" : mk,
          ...(mk === "function" && signature(mi) ? { sig: signature(mi) } : {}),
          doc: firstLine(m.docs),
          ...(deprecation(m) ? { deprecated: deprecation(m) } : {}),
        });
      }
      return;
    }
    if (kind === "struct" || kind === "enum" || kind === "union") {
      const variants =
        kind === "enum"
          ? ((inner.variants as (number | string)[]) ?? [])
              .map((v) => doc.index[String(v)]?.name ?? "")
              .filter(Boolean)
          : [];
      const methods: DocItem[] = [];
      for (const implId of ((inner.impls as (number | string)[]) ?? []).map(String)) {
        const impl = doc.index[implId]?.inner.impl as Json | undefined;
        if (!impl || impl.trait || impl.is_synthetic || impl.blanket_impl) continue;
        for (const mid of ((impl.items as (number | string)[]) ?? []).map(String)) {
          const m = doc.index[mid];
          const [mk, mi] = Object.entries(m?.inner ?? {})[0] ?? ["", {}];
          if (!m?.name || mk !== "function" || !visibleIn(m)) continue;
          methods.push({
            path: `${full}::${m.name}`,
            name: m.name,
            kind: "method",
            ...(signature(mi) ? { sig: signature(mi) } : {}),
            doc: firstLine(m.docs),
            ...(deprecation(m) ? { deprecated: deprecation(m) } : {}),
          });
        }
      }
      if (!add({ ...base, members: [...variants, ...methods.map((m) => m.name)] })) return;
      for (const m of methods) add(m);
      return;
    }
    add(base);
  };

  const member = (id: string, modulePath: string[], depth: number) => {
    const item = doc.index[id];
    if (!item) return;
    const use = item.inner.use as
      | { name?: string; id?: number | string | null; is_glob?: boolean }
      | undefined;
    if (use) {
      const target = use.id === null || use.id === undefined ? null : String(use.id);
      if (!target) return;
      if (use.is_glob) {
        const mod = doc.index[target]?.inner.module as Json | undefined;
        if (mod && depth < 10)
          for (const child of ((mod.items as (number | string)[]) ?? []).map(String))
            member(child, modulePath, depth + 1);
        return;
      }
      const path = [...modulePath, use.name ?? ""];
      if (doc.index[target]) named(target, path, depth);
      else {
        const external = doc.paths[target];
        if (external)
          add({
            path: path.join("::"),
            name: use.name ?? "",
            kind: external.kind,
            doc: `re-export of ${external.path.join("::")}`,
          });
      }
      return;
    }
    if (item.name && visibleIn(item)) named(id, [...modulePath, item.name], depth);
  };

  named(String(doc.root), [crate.replace(/-/g, "_")], 0);
  return out;
}

function render(item: DocItem) {
  const head = `${item.path} (${item.kind})${item.sig ? `: fn ${item.name}${item.sig}` : ""}`;
  return [
    head,
    item.deprecated ? `  deprecated ${item.deprecated}` : "",
    item.doc ? `  ${item.doc}` : "",
    item.members?.length ? `  members: ${item.members.slice(0, 30).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "use",
  "api",
  "crate",
  "how",
  "new",
  "docs",
  "migration",
  "guide",
  "version",
  "rust",
]);

/** The fix agent's `lookup_docs` for a crate: the target version's public items that match the query. */
export function rustDocsLookup(
  crate: string,
  from: string,
  to: string,
  load: (version: string) => Promise<DocItem[] | null> = async (v) => {
    const json = await rustdocJson(crate, v);
    return json ? rustdocItems(json.text, crate) : null;
  },
) {
  const loaded = new Map<string, Promise<DocItem[] | null>>();
  const items = (version: string) => {
    if (!loaded.has(version))
      loaded.set(
        version,
        load(version).catch(() => null),
      );
    return loaded.get(version) as Promise<DocItem[] | null>;
  };
  return async (query: string) => {
    const target = await items(to);
    if (!target)
      return `docs.rs has no rustdoc JSON for ${crate} ${to}; rely on the compiler's suggestions and https://docs.rs/${crate}/${to}/`;
    const crateIdent = crate.replace(/-/g, "_").toLowerCase();
    const tokens = [
      ...new Set(
        query
          .split(/[^A-Za-z0-9_]+/)
          .filter(
            (t) =>
              t.length >= 2 && !/^\d/.test(t) && t.toLowerCase() !== crateIdent && !STOP.has(t.toLowerCase()),
          ),
      ),
    ];
    const scored = target
      .map((item) => {
        const name = item.name.toLowerCase();
        const segments = item.path.toLowerCase().split("::");
        let score = 0;
        for (const t of tokens.map((x) => x.toLowerCase())) {
          if (name === t) score += 4;
          else if (segments.includes(t)) score += 2;
          else if (t.length >= 4 && name.includes(t)) score += 1;
        }
        // Shorter (re-exported) paths first among equals: the path a user writes.
        return { item, score: score - segments.length * 0.01 };
      })
      .filter((s) => s.score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, RUST.docsLookupMaxItems);
    const matches = [
      `${crate} ${to} public items matching "${query}" (rustdoc JSON from docs.rs):`,
      ...scored.map((s) => render(s.item)),
    ];
    const sections: string[] = [];

    // Names the target lacks: what they were in the old version, and same-signature candidates.
    const missing = tokens.filter((t) => !target.some((i) => i.name === t));
    if (missing.length) {
      const old = await items(from);
      for (const name of missing) {
        const was = old?.filter((i) => i.name === name) ?? [];
        if (!was.length) continue;
        const lines = [
          `\`${name}\` is not in ${crate} ${to}; in ${from}: ${was
            .slice(0, 3)
            .map((w) => `${w.path}${w.sig ? ` fn${w.sig}` : ""}`)
            .join("; ")}`,
        ];
        const shapes = new Set(
          was.filter((x) => x.sig).map((x) => `${x.kind} ${(x.sig ?? "").replace(/^<[^>]*>/, "")}`),
        );
        const renamed = target.filter(
          (i) => i.sig && i.name !== name && shapes.has(`${i.kind} ${(i.sig ?? "").replace(/^<[^>]*>/, "")}`),
        );
        if (renamed.length)
          lines.push(
            `  same signature in ${to} (possible rename): ${renamed
              .slice(0, 6)
              .map((r) => r.path)
              .join(", ")}`,
          );
        sections.push(lines.join("\n"));
      }
    }
    if (scored.length === 0) matches.push("no public item matches; try the exact names the compiler printed");
    // Renames first: they are the answer to most "where did X go" queries and must survive the cap.
    return [...sections, ...matches].join("\n\n").slice(0, RUST.docsLookupMaxChars);
  };
}
