import { SURFACE } from "../constants";
import { canonicalType } from "./ts-walk";
import type { ApiSurface, ApiSymbol, SurfaceChange, SurfaceChangeKind, SurfaceDiff } from "./types";

/**
 * Two surfaces → classified changes, deterministically (no model). The signature normalisations
 * are ported from emend's `diff.ts` (MIT, © 2026 Diyan Bogdanov, refs/emend/src/diff.ts): printer
 * `_2` suffixes, positional type and value parameters, agreed aliases and defaults, unions in one
 * order, defaulted type parameters appended as a widening. Teire's rules on top (plan S02a task 5):
 *  - a path gone from the new version is a removal only when no alias and no declaration with the
 *    same key exists there; otherwise it moved, and the new path is kept for the locator;
 *  - members of a removed parent fold into that removal;
 *  - arity from call signatures: fewer required or more accepted arguments is a break;
 *  - optional→required and new required properties on existing types are breaks for inputs;
 *  - "changed" type text stays drift (annotate only); deprecations are annotations.
 */
const CUT = "…<truncated>";

function withoutPrinterSuffixes(signature: string) {
  return signature.replace(/\b([A-Za-z_$][\w$]*?)_\d+\b/g, "$1");
}

interface Reduction {
  aliases: ReadonlyMap<string, string>;
  defaults: ReadonlyMap<string, readonly string[]>;
}

function readBinding(s: string, from: number): { rest: boolean; optional: boolean; end: number } | null {
  let i = from;
  while (s[i] === " ") i++;
  const rest = s.startsWith("...", i);
  if (rest) i += 3;
  const first = s[i];
  if (first === undefined) return null;
  if (first === "{" || first === "[") {
    const close = first === "{" ? "}" : "]";
    let depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === first) depth++;
      else if (s[i] === close && --depth === 0) {
        i++;
        break;
      }
    }
    if (depth !== 0) return null;
  } else if (/[A-Za-z_$]/.test(first)) {
    while (i < s.length && /[\w$]/.test(s[i] ?? "")) i++;
  } else return null;
  const optional = s[i] === "?";
  if (optional) i++;
  if (s[i] !== ":") return null;
  return { rest, optional, end: i + 1 };
}

const OPENERS = "({[<";
const CLOSERS = ")}]>";

/** Value-parameter names replaced by their position; object-type member names are kept. */
export function positionalParams(signature: string): string {
  const stack: { open: string; count: number }[] = [];
  let out = "";
  let i = 0;
  let atParamStart = false;
  while (i < signature.length) {
    const ch = signature[i] ?? "";
    if (ch === "=" && signature[i + 1] === ">") {
      out += "=>";
      i += 2;
      atParamStart = false;
      continue;
    }
    const group = stack[stack.length - 1];
    if (atParamStart && group?.open === "(") {
      const binding = readBinding(signature, i);
      if (binding) {
        out += `${binding.rest ? "..." : ""}p${group.count}${binding.optional ? "?" : ""}:`;
        group.count++;
        i = binding.end;
        atParamStart = false;
        continue;
      }
    }
    if (OPENERS.includes(ch)) {
      stack.push({ open: ch, count: 0 });
      atParamStart = ch === "(";
    } else if (CLOSERS.includes(ch)) {
      stack.pop();
      atParamStart = false;
    } else if (ch === ",") atParamStart = true;
    else if (ch !== " ") atParamStart = false;
    out += ch;
    i++;
  }
  return out;
}

function comparableSignature(symbol: ApiSymbol, reduce: Reduction): string {
  let out = symbol.signature;
  (symbol.typeParams ?? []).forEach((param, i) => {
    const escaped = param.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "g"), `\u0000T${i}`);
  });
  const reduced = withoutPrinterSuffixes(positionalParams(out.replaceAll("\u0000", "")));
  const substituted =
    reduce.aliases.size > 0
      ? reduced.replace(/\b[A-Za-z_$][\w$]*\b/g, (name) => reduce.aliases.get(name) ?? name)
      : reduced;
  return canonicalType(substituted, reduce.defaults);
}

function agreedAliases(from: ApiSurface, to: ApiSurface) {
  const reduced = (text: string) => withoutPrinterSuffixes(canonicalType(text));
  const agreed = new Map<string, string>();
  const theirs = to.typeAliases ?? {};
  for (const [name, expansion] of Object.entries(from.typeAliases ?? {})) {
    const other = theirs[name];
    if (other !== undefined && (other === expansion || reduced(other) === reduced(expansion)))
      agreed.set(name, expansion);
  }
  return agreed;
}

function agreedDefaults(from: ApiSurface, to: ApiSurface, aliases: ReadonlyMap<string, string>) {
  const agreed = new Set<string>();
  const theirs = to.typeDefaults ?? {};
  const reduced = (text: string) =>
    canonicalType(withoutPrinterSuffixes(text).replace(/\b[A-Za-z_$][\w$]*\b/g, (n) => aliases.get(n) ?? n));
  for (const [name, ours] of Object.entries(from.typeDefaults ?? {})) {
    const other = theirs[name];
    if (other === undefined) continue;
    let agrees = true;
    for (let i = 0; i < Math.min(ours.length, other.length); i++) {
      if (reduced(ours[i] ?? "") !== reduced(other[i] ?? "")) {
        agrees = false;
        break;
      }
    }
    if (agrees) agreed.add(name);
  }
  return agreed;
}

/** Only defaulted type parameters were appended and nothing else moved: a widening, not a break. */
export function widenedByDefaultedTypeParams(before: ApiSymbol, after: ApiSymbol) {
  const had = before.typeParams ?? [];
  const has = after.typeParams ?? [];
  if (has.length <= had.length) return false;
  for (let i = 0; i < had.length; i++) if (has[i]?.name !== had[i]?.name) return false;
  const added = has.slice(had.length);
  if (!added.every((p) => p.defaulted)) return false;
  let reduced = after.signature;
  for (const { name } of added) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    reduced = reduced.replace(new RegExp(`,\\s*${escaped}(\\s*=\\s*[^,>]+)?(?=\\s*[,>])`, "g"), "");
  }
  return reduced === before.signature;
}

/** Fewer required or fewer accepted arguments: some existing call stops compiling. */
function arityBreaks(before: ApiSymbol, after: ApiSymbol) {
  const a = before.arity;
  const b = after.arity;
  if (!a || !b) return null;
  const acceptsFewer = a.max === -1 ? b.max !== -1 : b.max !== -1 && b.max < a.max;
  if (b.min > a.min || acceptsFewer)
    return { minBefore: a.min, maxBefore: a.max, minAfter: b.min, maxAfter: b.max };
  return null;
}

/** Shapes callers build as object literals; a class instance is made by the package, not the caller. */
const OBJECT_KINDS = new Set(["interface", "type"]);

export function diffSurfaces(from: ApiSurface, to: ApiSurface): Omit<SurfaceDiff, "from" | "to" | "tool"> {
  const changes: SurfaceChange[] = [];
  const notes: string[] = [];
  const moved: Record<string, string> = {};
  const aliases = agreedAliases(from, to);
  const shared = agreedDefaults(from, to, aliases);
  const substitute = (text: string) =>
    aliases.size === 0 ? text : text.replace(/\b[A-Za-z_$][\w$]*\b/g, (n) => aliases.get(n) ?? n);
  const only = (all: Record<string, string[]> | undefined) =>
    new Map(
      Object.entries(all ?? {})
        .filter(([name]) => shared.has(name))
        .map(([name, defaults]) => [name, defaults.map(substitute)] as const),
    );
  const fromSide: Reduction = { aliases, defaults: only(from.typeDefaults) };
  const toSide: Reduction = { aliases, defaults: only(to.typeDefaults) };

  const emptyOf = (s: ApiSurface) => Object.keys(s.symbols).length === 0;
  const unanalyzable = emptyOf(from) || emptyOf(to);
  if (emptyOf(from)) notes.push(`${from.name}@${from.version}: ${from.note ?? "no symbols read"}`);
  if (emptyOf(to)) notes.push(`${to.name}@${to.version}: ${to.note ?? "no symbols read"}`);
  if (to.truncated) notes.push(`${to.name}@${to.version} surface was truncated; removals are not reported`);
  if (from.truncated)
    notes.push(`${from.name}@${from.version} surface was truncated; additions are not reported`);
  const suppressRemovals = to.truncated || unanalyzable;
  const suppressAdditions = from.truncated || unanalyzable;

  const toByDecl = new Map<string, string>();
  for (const [path, sym] of Object.entries(to.symbols))
    if (!toByDecl.has(sym.declKey)) toByDecl.set(sym.declKey, path);
  const partial: string[] = [];
  let environment = 0;

  if (!unanalyzable) {
    // Subpaths that no longer resolve: every deep import of them breaks.
    for (const subpath of Object.keys(from.entries)) {
      if (subpath in to.entries || suppressRemovals) continue;
      changes.push({
        path: subpath,
        declKey: null,
        kind: "entry-removed",
        severity: "breaking",
        before: from.entries[subpath] ?? null,
        after: null,
      });
    }

    for (const [path, before] of Object.entries(from.symbols)) {
      const after = to.symbols[path] ?? to.symbols[to.aliases[path] ?? ""];
      if (!after) {
        if (suppressRemovals) continue;
        const elsewhere = toByDecl.get(before.declKey);
        if (elsewhere) {
          moved[path] = elsewhere;
          continue;
        }
        // Declared in a type dependency the new version no longer has: the environment changed,
        // not this package's API (openai 4 depends on @types/node, 5 does not).
        const dep = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(before.declKey)?.[1];
        if (dep && !(to.typeDeps ?? []).includes(dep)) {
          environment++;
          continue;
        }
        changes.push({
          path,
          declKey: before.declKey,
          kind: "removed",
          symbolKind: before.kind,
          severity: "breaking",
          before: before.signature,
          after: null,
        });
        continue;
      }

      if (after.deprecated)
        changes.push({
          path,
          declKey: after.declKey,
          kind: "deprecated",
          symbolKind: after.kind,
          severity: "deprecation",
          before: before.signature,
          after: after.signature,
          newlyDeprecated: !before.deprecated,
          ...(after.doc ? { guidance: after.doc } : {}),
        });

      if (before.optional && !after.optional && after.kind === "property") {
        changes.push({
          path,
          declKey: after.declKey,
          kind: "optional-to-required",
          symbolKind: after.kind,
          severity: "breaking",
          before: before.signature,
          after: after.signature,
        });
        continue;
      }

      const arity = arityBreaks(before, after);
      if (arity) {
        changes.push({
          path,
          declKey: after.declKey,
          kind: "arity-changed",
          symbolKind: after.kind,
          severity: "breaking",
          before: before.signature,
          after: after.signature,
          arity,
        });
        continue;
      }

      if (before.signature.endsWith(CUT) || after.signature.endsWith(CUT)) partial.push(path);
      if (
        before.signature !== after.signature &&
        comparableSignature(before, fromSide) !== comparableSignature(after, toSide)
      ) {
        const hadTp = before.typeParams ?? [];
        const hasTp = after.typeParams ?? [];
        const gainedRequiredTypeParam =
          hasTp.length > hadTp.length && hasTp.slice(hadTp.length).some((t) => !t.defaulted);
        const widened = widenedByDefaultedTypeParams(before, after);
        changes.push({
          path,
          declKey: after.declKey,
          kind: "signature-changed",
          symbolKind: after.kind,
          severity: widened ? "feature" : gainedRequiredTypeParam ? "breaking" : "drift",
          before: before.signature,
          after: after.signature,
        });
      }
    }

    for (const [path, after] of Object.entries(to.symbols)) {
      if (from.symbols[path] || from.aliases[path]) continue;
      // A new required property on a type both versions have breaks every object literal of it.
      const parent = after.parent ? from.symbols[after.parent] : undefined;
      if (
        after.kind === "property" &&
        !after.optional &&
        parent &&
        OBJECT_KINDS.has(parent.kind) &&
        to.symbols[after.parent ?? ""]
      ) {
        changes.push({
          path,
          declKey: after.declKey,
          kind: "required-added",
          symbolKind: after.kind,
          severity: "breaking",
          before: null,
          after: after.signature,
        });
        continue;
      }
      if (suppressAdditions) continue;
      changes.push({
        path,
        declKey: after.declKey,
        kind: "added",
        symbolKind: after.kind,
        severity: "feature",
        before: null,
        after: after.signature.slice(0, SURFACE.recordSignatureChars),
      });
    }
  }

  // One removal per declaration: an inherited member removed under every subclass is one change.
  const folded = new Set<SurfaceChange>();
  const firstByDecl = new Map<string, SurfaceChange>();
  for (const change of changes) {
    if (change.kind !== "removed" || !change.declKey) continue;
    const first = firstByDecl.get(change.declKey);
    if (!first) {
      firstByDecl.set(change.declKey, change);
      continue;
    }
    first.alsoAt ??= [];
    first.alsoAt.push(change.path);
    folded.add(change);
  }
  // Fold members of a removed parent into it: one finding per thing that went away.
  // Every removed path (deduplicated ones included) points at the change that represents it.
  const removed = new Map<string, SurfaceChange>();
  for (const c of changes) {
    if (c.kind !== "removed") continue;
    const representative = (c.declKey && firstByDecl.get(c.declKey)) || c;
    removed.set(c.path, representative);
  }
  for (const change of changes) {
    if (change.kind !== "removed" || folded.has(change)) continue;
    let parentPath = from.symbols[change.path]?.parent;
    let top: SurfaceChange | undefined;
    while (parentPath) {
      const hit = removed.get(parentPath);
      if (hit && hit !== change) top = hit;
      parentPath = from.symbols[parentPath]?.parent;
    }
    if (top && !folded.has(top)) {
      top.children ??= [];
      top.children.push({ path: change.path, declKey: change.declKey ?? "" });
      folded.add(change);
    }
  }
  const kept = changes.filter((c) => !folded.has(c));
  if (environment)
    notes.push(
      `${environment} path(s) declared by type dependencies the new version no longer has are not counted`,
    );
  const movedCount = Object.keys(moved).length;
  if (movedCount)
    notes.push(
      `${movedCount} path(s) moved to another route to the same declaration and are not counted as removed`,
    );
  if (partial.length)
    notes.push(`${partial.length} signature(s) were stored in part and compared only as far as kept`);

  const counts: Partial<Record<SurfaceChangeKind, number>> = {};
  for (const c of kept) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  return {
    ecosystem: "npm",
    name: from.name,
    fromVersion: from.version,
    toVersion: to.version,
    changes: kept,
    counts,
    moved,
    unanalyzable,
    notes,
  };
}
