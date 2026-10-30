import { sha256 } from "../catalog/source";
import { SURFACE } from "../constants";
import { type ChangeKindV2, type ChangeV2, changeV2, type Signature } from "../contract";
import type { SurfaceChange, SurfaceChangeKind, SurfaceDiff, SymbolKind } from "./types";

/**
 * A surface diff as catalog change records: one record per kind of change per version pair
 * (`npm/openai/4.104.0..5.23.2/symbol-removed`), each listing every symbol as a signature the
 * locator joins on by declaration key. Removals, arity breaks and removed subpaths are confirmed;
 * optional→required and new required properties are candidates until a located use shows the type
 * is built by the caller (output types gaining a field break nobody).
 */
const KIND: Partial<Record<SurfaceChangeKind, ChangeKindV2>> = {
  removed: "symbol-removed",
  "arity-changed": "arity-changed",
  "optional-to-required": "optional-to-required",
  "required-added": "required-added",
  "entry-removed": "deep-import-removed",
  "parameter-removed": "parameter-change",
  "parameter-changed": "parameter-change",
  "signature-changed": "symbol-changed",
  deprecated: "symbol-deprecated",
};

const MEMBER_KIND: Record<SymbolKind, Extract<Signature, { kind: "symbol" }>["memberKind"]> = {
  class: "class",
  interface: "type",
  type: "type",
  enum: "type",
  method: "method",
  function: "function",
  property: "property",
  variable: "variable",
  module: "module",
  unknown: "variable",
};

const TITLE: Record<ChangeKindV2, string> = {
  "symbol-removed": "removes {n} API(s)",
  "arity-changed": "changes the arguments of {n} function(s)",
  "optional-to-required": "makes {n} propert(ies) required",
  "required-added": "adds {n} required propert(ies) to existing types",
  "deep-import-removed": "removes {n} import path(s)",
  "symbol-changed": "changes the types of {n} API(s)",
  "symbol-deprecated": "deprecates {n} API(s)",
  "parameter-change": "changes parameters of {n} function(s)",
} as Record<ChangeKindV2, string>;

const LANG = { npm: "ts", pypi: "py", maven: "jvm", go: "go", cargo: "rust", rubygems: "ruby" } as const;

const REGISTRY_PAGE: Record<SurfaceDiff["ecosystem"], (name: string, version: string) => string> = {
  npm: (n, v) => `https://registry.npmjs.org/${n}/${v}`,
  pypi: (n, v) => `https://pypi.org/project/${n}/${v}/`,
  maven: (n, v) => `https://central.sonatype.com/artifact/${n.replace(":", "/")}/${v}`,
  go: (n, v) => `https://pkg.go.dev/${n}@${v}`,
  cargo: (n, v) => `https://crates.io/crates/${n}/${v}`,
  rubygems: (n, v) => `https://rubygems.org/gems/${n}/versions/${v}`,
};

const clip = (text: string | null) => (text ? text.slice(0, SURFACE.recordSignatureChars) : undefined);

function symbolSignature(
  c: SurfaceChange,
  path = c.path,
  declKey = c.declKey ?? "",
  ecosystem: SurfaceDiff["ecosystem"] = "npm",
): Signature {
  return {
    kind: "symbol",
    lang: LANG[ecosystem],
    declKey: declKey || path,
    path,
    memberKind: MEMBER_KIND[c.symbolKind ?? "unknown"],
    ...(clip(c.before) ? { before: clip(c.before) } : {}),
    ...(clip(c.after) ? { after: clip(c.after) } : {}),
    ...(c.arity ? { arity: c.arity } : {}),
  };
}

function signaturesOf(name: string, c: SurfaceChange, ecosystem: SurfaceDiff["ecosystem"]): Signature[] {
  if (c.kind === "entry-removed")
    return [
      {
        kind: "import-path",
        value:
          ecosystem === "npm" ? (c.path === "." ? name : `${name}/${c.path.replace(/^\.\//, "")}`) : c.path,
      },
    ];
  const out = [symbolSignature(c, c.path, c.declKey ?? "", ecosystem)];
  // A removed keyword breaks only the calls that pass it: the locator checks the argument.
  if (c.kind === "parameter-removed" && c.param)
    out.push({ kind: "call-arg", callee: [c.declKey ?? c.path], arg: c.param });
  for (const path of c.alsoAt ?? []) out.push(symbolSignature(c, path));
  for (const child of c.children ?? [])
    out.push(symbolSignature({ ...c, before: null, after: null }, child.path, child.declKey));
  return out;
}

/**
 * A diff whose tool failed (a release with no wheel, a registry error, a toolchain crash): unreadable,
 * with the reason, so one package's failure becomes "compare it by hand" instead of ending the scan.
 */
export function unreadableDiff(
  ecosystem: SurfaceDiff["ecosystem"],
  name: string,
  fromVersion: string,
  toVersion: string,
  error: unknown,
): SurfaceDiff {
  const side = { source: { kind: "bundled" as const }, symbols: 0, truncated: false, ms: 0, integrity: "" };
  return {
    ecosystem,
    name,
    fromVersion,
    toVersion,
    from: side,
    to: side,
    changes: [],
    counts: {},
    moved: {},
    unanalyzable: true,
    notes: [
      (error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 300) ?? "failed",
    ],
    tool: { name: "surface-diff", version: "failed", noiseFilterVersion: SURFACE.noiseFilterVersion },
  };
}

export function surfaceChangeRecords(diff: SurfaceDiff, checkedAt = new Date().toISOString()): ChangeV2[] {
  const contentHash = sha256(JSON.stringify(diff.changes));
  const source = {
    url: REGISTRY_PAGE[diff.ecosystem](diff.name, diff.toVersion),
    kind: "surface-diff" as const,
    trustBasis: "computed" as const,
    contentHash,
    checkedAt,
    tool: { name: diff.tool.name, version: diff.tool.version },
  };
  // Could not read one side (or part of it): say so as a change with nothing to search for
  // ("check by hand"), never as an empty diff that would read as "no breaking changes" (D74).
  const uncompared = (title: string, suffix: string) =>
    changeV2.parse({
      schemaVersion: 2,
      id: `${diff.ecosystem}/${diff.name}/${diff.fromVersion}..${diff.toVersion}/${suffix}`,
      subject: { kind: "package", ecosystem: diff.ecosystem, name: diff.name },
      kind: "package-major",
      title,
      summary: [...new Set(diff.notes)].join("; ") || "One side's declarations could not be read.",
      applicability: {
        class: "breaks-on-upgrade",
        affectedRange: diff.fromVersion,
        fromVersion: diff.fromVersion,
        toVersion: diff.toVersion,
      },
      sources: [source],
      provenance: { method: "tool", tool: diff.tool, confidence: { overall: 0.3 } },
      visibility: "public",
      status: "candidate",
    });
  if (diff.unanalyzable)
    return [
      uncompared(
        `${diff.name} ${diff.toVersion}: API surface could not be compared with ${diff.fromVersion}`,
        "package-major",
      ),
    ];
  const groups = new Map<ChangeKindV2, SurfaceChange[]>();
  for (const c of diff.changes) {
    const kind = KIND[c.kind];
    if (!kind) continue;
    groups.set(kind, [...(groups.get(kind) ?? []), c]);
  }
  const records: ChangeV2[] = [];
  for (const [kind, list] of groups) {
    // Ruby's surface is read statically from a dynamic language: a symbol change stays a candidate
    // until a changelog quote or the sandbox confirms it (plan S07); a removed file or dependency is certain.
    const candidate =
      kind === "optional-to-required" ||
      kind === "required-added" ||
      (diff.ecosystem === "rubygems" && kind !== "deep-import-removed");
    const drift = kind === "symbol-changed" || kind === "symbol-deprecated";
    const headline = list
      .slice(0, 5)
      .map((c) => `\`${c.path}\``)
      .join(", ");
    const newly = kind === "symbol-deprecated" ? list.filter((c) => c.newlyDeprecated).length : 0;
    // Deterministic edits the target's surface backs (R21.7): a class or function at a new import
    // path, and keywords a function no longer takes.
    // Python only: npm's moved subpaths are rewritten by its own import codemod.
    const moves =
      diff.ecosystem === "pypi"
        ? list.flatMap((c) => (c.movedTo ? [{ from: c.path, to: c.movedTo }] : []))
        : [];
    const removedKeywords = list.flatMap((c) =>
      c.kind === "parameter-removed" && c.param ? [{ callee: c.declKey ?? c.path, arg: c.param }] : [],
    );
    const codemod = moves.length
      ? { kind: "import-rewrite" as const, spec: { moves } }
      : removedKeywords.length && diff.ecosystem === "pypi"
        ? { kind: "kwarg-remove" as const, spec: { removed: removedKeywords } }
        : null;
    records.push(
      changeV2.parse({
        schemaVersion: 2,
        id: `${diff.ecosystem}/${diff.name}/${diff.fromVersion}..${diff.toVersion}/${kind}`,
        subject: { kind: "package", ecosystem: diff.ecosystem, name: diff.name },
        kind,
        // Both versions: a Go major moves the module path, so "<name> <to>" alone would mislead.
        title: `${diff.name} ${diff.fromVersion} → ${diff.toVersion}: ${(TITLE[kind] ?? "changes {n} API(s)").replace("{n}", String(list.length))}`,
        summary: `Compared with ${diff.fromVersion}: ${headline}${list.length > 5 ? `, and ${list.length - 5} more` : ""}.${newly ? ` ${newly} newly deprecated.` : ""}${moves.length ? ` ${moves.length} moved to a new import path.` : ""}`,
        applicability: {
          class: "breaks-on-upgrade",
          affectedRange: diff.fromVersion,
          fromVersion: diff.fromVersion,
          toVersion: diff.toVersion,
        },
        signatures: list.flatMap((c) => signaturesOf(diff.name, c, diff.ecosystem)),
        ...(codemod
          ? {
              replacement: {
                value:
                  codemod.kind === "import-rewrite"
                    ? moves
                        .map((m) => `${m.from} → ${m.to}`)
                        .join("; ")
                        .slice(0, 500)
                    : `drop ${removedKeywords.map((r) => `\`${r.arg}=\``).join(", ")}`.slice(0, 500),
                codemod,
              },
            }
          : {}),
        migrationNotes: list
          .filter((c) => c.guidance)
          .slice(0, 50)
          .map((c) => ({ text: `${c.path}: ${c.guidance}`, sourceIndex: 0 })),
        sources: [source],
        provenance: {
          method: "tool",
          tool: diff.tool,
          confidence: { overall: candidate ? 0.6 : drift ? 0.5 : 1 },
        },
        visibility: "public",
        status: candidate ? "candidate" : "confirmed",
      }),
    );
  }
  if (diff.partial?.length)
    records.push(
      uncompared(
        `${diff.name} ${diff.toVersion}: ${diff.partial.map((m) => `\`${m}\``).join(", ")} compared only in part with ${diff.fromVersion}`,
        "package-major-partial",
      ),
    );
  return records;
}
