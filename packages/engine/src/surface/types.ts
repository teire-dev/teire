/**
 * The public API of one package version, read from its declarations, and the diff between two.
 * Shapes follow emend's (MIT, refs/emend/src/types.ts) with what Teire adds: a declaration key per
 * symbol so the locator can join on it and path moves are not mistaken for removals, real arity
 * from call signatures, and subpath entries for deep imports.
 */
export type SymbolKind =
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "method"
  | "function"
  | "property"
  | "variable"
  | "module"
  | "unknown";

export interface TypeParam {
  name: string;
  /** True when the declaration gives it a default, so callers may leave it out. */
  defaulted: boolean;
}

/** Arguments a caller must and may pass; `max` is -1 for a rest parameter. */
export interface Arity {
  min: number;
  max: number;
}

export interface ApiSymbol {
  /** Dotted path from the entry, e.g. `OpenAI.Beta.Chat.Completions.parse`; subpaths prefix `<subpath>:`. */
  path: string;
  /** `<declaration file without .d.ts>#<qualified name>`, stable across versions and paths. */
  declKey: string;
  kind: SymbolKind;
  /** Normalised type text (absolute cache paths removed, whitespace collapsed, capped). */
  signature: string;
  deprecated: boolean;
  /** What a deprecated declaration says to do instead (description, `@deprecated`, `@see`). */
  doc?: string;
  optional: boolean;
  typeParams?: TypeParam[];
  arity?: Arity;
  /** Path of the symbol this one is a member of. */
  parent?: string;
}

export type TypesSource =
  | { kind: "bundled" }
  | { kind: "definitely-typed"; name: string; version: string; approximate: boolean }
  | { kind: "exports-only"; lexer: "cjs-module-lexer" | "es-module-lexer" };

export interface ApiSurface {
  name: string;
  version: string;
  source: TypesSource;
  /** Subpath (`.`, `./azure`) → declaration file relative to the package root. */
  entries: Record<string, string>;
  /** `exports` keys with `*`, kept for deep-import existence checks. */
  wildcards: string[];
  /** Packages in the type-dependency closure the walk could read. */
  typeDeps?: string[];
  symbols: Record<string, ApiSymbol>;
  /** `OwnerType.member` → canonical path, for values typed by their class (`client.chat`). */
  byTypeMember: Record<string, string>;
  /** Alternate route → canonical path, for symbols reachable more than one way. */
  aliases: Record<string, string>;
  typeAliases?: Record<string, string>;
  typeDefaults?: Record<string, string[]>;
  truncated: boolean;
  /** Why the surface is empty or partial; never "no changes". */
  note?: string;
}

export type SurfaceChangeKind =
  | "removed"
  | "arity-changed"
  | "optional-to-required"
  | "required-added"
  | "deprecated"
  | "signature-changed"
  | "added"
  | "entry-removed";

export interface SurfaceChange {
  path: string;
  declKey: string | null;
  kind: SurfaceChangeKind;
  symbolKind?: SymbolKind;
  /**
   * breaking: provably stops compiling (removed, fewer accepted or more required arguments, a
   * required property on an input type). drift: type text moved and a string comparison cannot
   * say whether it bites. deprecation, feature: annotate only.
   */
  severity: "breaking" | "drift" | "deprecation" | "feature";
  before: string | null;
  after: string | null;
  arity?: { minBefore: number; maxBefore: number; minAfter: number; maxAfter: number };
  /** The same declaration is reachable at this new path (a move, with its replacement). */
  movedTo?: string;
  /** Other paths to the same removed declaration (an inherited member under each subclass). */
  alsoAt?: string[];
  /** Removed members folded under a removed parent (path and declKey each). */
  children?: { path: string; declKey: string }[];
  /** Only in the version moved to: first deprecated there. */
  newlyDeprecated?: boolean;
  guidance?: string;
}

export interface SurfaceSide {
  source: TypesSource;
  symbols: number;
  truncated: boolean;
  ms: number;
  /** Integrity of the tarball the surface was read from (checked against the registry). */
  integrity: string;
}

export interface SurfaceDiff {
  ecosystem: "npm";
  name: string;
  fromVersion: string;
  toVersion: string;
  from: SurfaceSide;
  to: SurfaceSide;
  changes: SurfaceChange[];
  counts: Partial<Record<SurfaceChangeKind, number>>;
  /** Old path → new path for symbols reachable only by another route to the same declaration. */
  moved: Record<string, string>;
  /** True when either side could not be read; then the diff proves nothing either way. */
  unanalyzable: boolean;
  notes: string[];
  tool: { name: string; version: string; noiseFilterVersion: string };
}
