import { fromBinary } from "@bufbuild/protobuf";
import { IndexSchema, type Occurrence } from "@scip-code/scip";
import type { Hit, LocateResult } from "./ts";

/**
 * rust-analyzer's SCIP index read as type-resolved references (S19): the sandbox runs
 * `rust-analyzer scip` on the repository (build scripts and proc-macros run there, never here), and
 * each reference to the dependency at its installed version becomes a site with resolution "type".
 * A lexical site SCIP has no occurrence for (a macro, a cfg'd-out file) stays unresolved, so the
 * verdict can't read "not affected" over code the index didn't see.
 */
export interface ScipRef {
  file: string;
  /** 1-based, like every other site. */
  line: number;
  column: number;
  crate: string;
  version: string;
  owner: string | null;
  name: string;
  import: boolean;
}

/**
 * `rust-analyzer cargo reqwest 0.13.5 async_impl/client/impl#[Client]post().` → the crate, its
 * version, and the item (`post`) with its owner type (`Client`). SCIP names the defining path, not
 * the public re-export, so items are matched by owner and name within the crate.
 */
export function parseRustSymbol(symbol: string) {
  const m = /^rust-analyzer cargo (\S+) (\S+) (.+)$/.exec(symbol);
  if (!m) return null;
  const [, crate, version, descriptors] = m as unknown as [string, string, string, string];
  const tokens = [
    ...descriptors.matchAll(/\[([^\]]+)\]|(`[^`]*`|[^/#.()[\]!:\s]+)(\([^)]*\)\.|\/|#|\.|!|:)/g),
  ].map((t) =>
    t[1] !== undefined
      ? { kind: "param" as const, name: t[1] }
      : {
          kind: t[3] === "/" ? ("ns" as const) : t[3] === "#" ? ("type" as const) : ("item" as const),
          name: (t[2] ?? "").replace(/`/g, ""),
        },
  );
  const last = [...tokens].reverse().find((t) => t.kind !== "param");
  if (!last) return null;
  const before = tokens.slice(0, tokens.lastIndexOf(last));
  const param = [...before].reverse().find((t) => t.kind === "param");
  const type = [...before].reverse().find((t) => t.kind === "type" && t.name !== "impl");
  return {
    crate: crate.replace(/-/g, "_"),
    version,
    owner: param?.name ?? type?.name ?? null,
    name: last.name,
  };
}

const startOf = (o: Occurrence) => {
  if (o.typedRange?.case === "singleLineRange")
    return { line: o.typedRange.value.line, column: o.typedRange.value.startCharacter };
  if (o.typedRange?.case === "multiLineRange")
    return { line: o.typedRange.value.startLine, column: o.typedRange.value.startCharacter };
  // rust-analyzer writes the deprecated `range`: [line, start, (endLine,) end], 0-based.
  return o.range.length >= 3 ? { line: o.range[0] as number, column: o.range[1] as number } : null;
};

/** Every reference (not definition) to `crate` in the index, with the files it covers. */
export function readScipIndex(bytes: Uint8Array, crate: string) {
  const index = fromBinary(IndexSchema, bytes);
  const want = crate.replace(/-/g, "_");
  const refs: ScipRef[] = [];
  const files = new Set<string>();
  for (const doc of index.documents) {
    files.add(doc.relativePath);
    for (const o of doc.occurrences) {
      // SymbolRole.Definition = 1, Import = 2.
      if (o.symbolRoles & 1) continue;
      const sym = parseRustSymbol(o.symbol);
      if (!sym || sym.crate !== want) continue;
      const at = startOf(o);
      if (!at) continue;
      refs.push({
        file: doc.relativePath,
        line: at.line + 1,
        column: at.column + 1,
        ...sym,
        import: (o.symbolRoles & 2) !== 0,
      });
    }
  }
  return { refs, files };
}

/** `time::OffsetDateTime::now_local` → owner `OffsetDateTime`, name `now_local`. */
function keyParts(key: string) {
  const segments = key.split("::");
  const name = segments.at(-1) ?? key;
  const owner =
    segments.length > 2 && /^[A-Z]/.test(segments.at(-2) ?? "") ? (segments.at(-2) as string) : null;
  return { crate: (segments[0] ?? "").replace(/-/g, "_"), owner, name };
}

/**
 * The lexical result with SCIP's type-resolved references in place of its by-path matches: each
 * reference to a looked-for item at the installed version is a "type" site; a lexical site whose
 * line SCIP doesn't reference the crate on is unresolved; a source file that names the crate but
 * that the index has no document for (cfg'd out, not a target) is skipped and counted as unresolved.
 * `feature:` keys (Cargo.toml lines) stay lexical.
 */
export function mergeScip(
  lexical: LocateResult,
  scip: { refs: ScipRef[]; files: Set<string> },
  input: {
    projectRoot: string;
    version: string;
    declKeys: ReadonlySet<string>;
    /** Repo-relative `.rs` files that name the crate. */
    sourceFiles: string[];
    lineOf: (file: string, line: number) => string;
  },
): LocateResult {
  const prefix = input.projectRoot === "." ? "" : `${input.projectRoot}/`;
  const keys = [...input.declKeys]
    .filter((k) => !k.startsWith("feature:"))
    .map((k) => ({ key: k, ...keyParts(k) }));
  const refs = scip.refs.filter((r) => r.version === input.version);
  const hits: Hit[] = lexical.hits.filter((h) => h.declKey?.startsWith("feature:"));
  for (const r of refs) {
    const key = keys.find(
      (k) => k.crate === r.crate && k.name === r.name && (!k.owner || !r.owner || k.owner === r.owner),
    );
    if (!key) continue;
    const file = `${prefix}${r.file}`;
    if (hits.some((h) => h.file === file && h.line === r.line && h.declKey === key.key)) continue;
    const lexicalKind = lexical.hits.find((h) => h.file === file && h.line === r.line)?.kind;
    hits.push({
      file,
      line: r.line,
      column: r.column,
      kind: r.import ? "import" : (lexicalKind ?? "call"),
      snippet: input.lineOf(file, r.line).trim().slice(0, 200),
      resolution: "type",
      declKey: key.key,
    });
  }
  const referenced = new Set(refs.map((r) => `${prefix}${r.file}:${r.line}`));
  const unresolved = lexical.hits.filter(
    (h) => !h.declKey?.startsWith("feature:") && !referenced.has(`${h.file}:${h.line}`),
  ).length;
  const unindexed = input.sourceFiles.filter((f) => !scip.files.has(f.slice(prefix.length)));
  return {
    ...lexical,
    hits,
    coverage: {
      ...lexical.coverage,
      filesSkipped: [
        ...lexical.coverage.filesSkipped,
        ...(unindexed.length
          ? [{ reason: "not in rust-analyzer's index (cfg'd out or not a target)", count: unindexed.length }]
          : []),
      ],
      resolutionLevel: "type",
      unresolvedSites: unresolved + unindexed.length,
    },
  };
}
