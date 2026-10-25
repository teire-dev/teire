import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GO, SURFACE } from "../constants";
import { runGoHelper, scratchHome } from "../golang/toolchain";
import type { SurfaceChange, SurfaceChangeKind, SurfaceDiff, SymbolKind } from "./types";

/**
 * Go API-surface diff (plan S05, D57; research go.md Job 4): golang.org/x/exp/apidiff through
 * Teire's helper, which loads both versions as modules (two module paths across a major) and
 * type-checks them without running anything. apidiff's own judgement decides what is incompatible;
 * Teire then:
 *  - folds `/vN` import-path noise (89% of a cross-major diff in the research: a signature that
 *    mentions another package of the same module changes only by path);
 *  - skips methods of unexported types (callers cannot name them);
 *  - reads a changed function signature for arity: a trailing `...Option` added keeps every call
 *    compiling, so it annotates; fewer or more required arguments break.
 */
interface HelperChange {
  message: string;
  compatible: boolean;
}

/** Parameter count of a `func(...)` type text (top level only); `variadic` when the last is `...T`. */
export function goParams(sig: string): { count: number; variadic: boolean } | null {
  const start = sig.indexOf("func(");
  if (start < 0) return null;
  let depth = 0;
  let current = "";
  const params: string[] = [];
  for (let i = start + 5; i < sig.length; i++) {
    const c = sig[i] as string;
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        if (current.trim()) params.push(current.trim());
        break;
      }
      depth--;
    }
    if (c === "," && depth === 0) {
      params.push(current.trim());
      current = "";
    } else current += c;
  }
  return { count: params.length, variadic: params.at(-1)?.startsWith("...") ?? false };
}

const NAME = /^(?:\.\/[\w./-]+\.)?(?:\(\*?([A-Za-z_]\w*)\)|([A-Za-z_]\w*))(?:\.([A-Za-z_]\w*))?$/;

function symbolKindOf(name: string, message: string): SymbolKind {
  if (/^\(?\*?\w+\)?\.\w+$/.test(name.replace(/^\.\/[\w./-]+\./, "")))
    return message.includes("func(") ? "method" : "property";
  if (message.includes("func(")) return "function";
  return "unknown";
}

/** One apidiff line → a surface change, or null when it is noise. */
export function goChange(raw: HelperChange, oldPath: string, newPath: string): SurfaceChange | null {
  // Fold the new module path into the old one, then drop changes that were only the path.
  const message = oldPath === newPath ? raw.message : raw.message.split(newPath).join(oldPath);
  const colon = message.indexOf(": ");
  if (colon < 0) return null;
  const name = message.slice(0, colon);
  const what = message.slice(colon + 2);
  const parts = NAME.exec(name);
  const typeName = parts?.[1] ?? parts?.[2] ?? "";
  // Methods and fields of unexported types: no caller can name them.
  if (parts?.[3] && /^[a-z_]/.test(typeName)) return null;
  const changed = /^changed from (.+) to (.+)$/.exec(what);
  if (changed && changed[1] === changed[2]) return null;
  const base = {
    path: name,
    declKey: name,
    symbolKind: symbolKindOf(name, what),
    before: null,
    after: null,
  } as const;
  if (raw.compatible) return null;
  if (what === "removed") return { ...base, kind: "removed", severity: "breaking" };
  if (what === "added")
    // An incompatible addition is a method added to an interface: every implementation must add it.
    return { ...base, kind: "required-added", severity: "breaking", symbolKind: "interface" };
  if (changed) {
    const [before, after] = [changed[1] ?? "", changed[2] ?? ""];
    const a = goParams(before);
    const b = goParams(after);
    if (a && b) {
      const kind: SurfaceChangeKind = "arity-changed";
      // Only a trailing variadic was added: every existing call still compiles.
      if (!a.variadic && b.variadic && b.count === a.count + 1)
        return { ...base, kind: "signature-changed", severity: "drift", before, after };
      if (a.count !== b.count || a.variadic !== b.variadic)
        return {
          ...base,
          kind,
          severity: "breaking",
          before,
          after,
          arity: {
            minBefore: a.variadic ? a.count - 1 : a.count,
            maxBefore: a.variadic ? -1 : a.count,
            minAfter: b.variadic ? b.count - 1 : b.count,
            maxAfter: b.variadic ? -1 : b.count,
          },
        };
    }
    return { ...base, kind: "signature-changed", severity: "drift", before, after };
  }
  // "old is comparable, new is not", "value changed from …", and similar: annotate.
  return { ...base, kind: "signature-changed", severity: "drift", before: null, after: what };
}

export async function goSurfaceDiff(
  oldPath: string,
  oldVersion: string,
  newPath: string,
  newVersion: string,
): Promise<SurfaceDiff> {
  const started = Date.now();
  const home = await scratchHome();
  const work = await mkdtemp(join(tmpdir(), "teire-apidiff-"));
  const notes: string[] = [];
  let changes: SurfaceChange[] = [];
  let unanalyzable = false;
  let packages = { old: 0, new: 0 };
  try {
    const out = await runGoHelper<{
      changes: HelperChange[];
      old: { packages: number };
      new: { packages: number };
      toolchain: string;
    }>(
      "apidiff",
      ["-old", `${oldPath}@${oldVersion}`, "-new", `${newPath}@${newVersion}`, "-work", work],
      work,
      home,
    );
    packages = { old: out.old.packages, new: out.new.packages };
    changes = out.changes.flatMap((c) => goChange(c, oldPath, newPath) ?? []);
    notes.push(
      `apidiff on ${out.toolchain}: ${out.changes.filter((c) => !c.compatible).length} incompatible line(s) before folding`,
    );
  } catch (error) {
    unanalyzable = true;
    notes.push(
      `apidiff could not compare: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
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
    ecosystem: "go",
    name: oldPath,
    fromVersion: oldVersion,
    toVersion: newVersion,
    from: side(packages.old),
    to: side(packages.new),
    changes,
    counts,
    moved: {},
    unanalyzable,
    notes: oldPath === newPath ? notes : [`major path ${oldPath} → ${newPath}`, ...notes],
    tool: { name: "apidiff", version: GO.apidiffVersion, noiseFilterVersion: SURFACE.noiseFilterVersion },
  };
}
