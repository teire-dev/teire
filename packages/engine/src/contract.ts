import { z } from "zod";
import type { EvidenceKind } from "./constants";

/**
 * Contract v2 (plan "Data model", round-2 reviews): the dependency is the root object, a change
 * says exactly when it applies, signatures are structured matchers, and every claim keeps its
 * provenance. The provider-table records of schema v1 move to this shape in S04.
 */

export const ECOSYSTEMS = ["npm", "pypi", "maven", "go", "cargo", "rubygems"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const subject = z.object({
  kind: z.enum(["package", "api-host", "model", "runtime"]),
  ecosystem: z.enum(ECOSYSTEMS).optional(),
  /** Registry name (not an alias); `group:artifact` for Maven; module path for Go; host for APIs. */
  name: z.string().min(1),
  /** Optional curated presentation (logo, provider page). */
  provider: slug.optional(),
});
export type Subject = z.infer<typeof subject>;

export const changeKindsV2 = [
  "symbol-removed",
  "symbol-changed",
  "arity-changed",
  "required-added",
  "optional-to-required",
  "deep-import-removed",
  "feature-removed",
  "package-major",
  "package-deprecated",
  "package-yanked",
  "security-advisory",
  "model-retirement",
  "model-rerouted",
  "api-version-sunset",
  "parameter-change",
  "endpoint-removal",
  "behaviour-change",
  "runtime-eol",
  "account-gated",
] as const;
export type ChangeKindV2 = (typeof changeKindsV2)[number];

/** Change kinds allowed to open a pull request on their own (plan D70); the rest annotate. */
export const PR_OPENING_KINDS: ReadonlySet<ChangeKindV2> = new Set([
  "symbol-removed",
  "arity-changed",
  "required-added",
  "optional-to-required",
  "deep-import-removed",
  "feature-removed",
  "package-yanked",
  "security-advisory",
  "model-retirement",
  "api-version-sunset",
  "parameter-change",
  "endpoint-removal",
]);

export const applicabilityClasses = [
  "breaks-on-date",
  "breaks-on-upgrade",
  "already-broken",
  "security",
  /** Flagged by a registry or vendor (deprecated, unmaintained, renamed) with nothing breaking yet (D76). */
  "notice",
] as const;
export type ApplicabilityClass = (typeof applicabilityClasses)[number];

export const applicability = z.object({
  class: z.enum(applicabilityClasses),
  /** Versions the change affects, in the ecosystem's own range grammar. */
  affectedRange: z.string().optional(),
  /** Smallest fixed version per release line (advisories). */
  fixedIn: z.array(z.string()).default([]),
  /** The diffed pair for breaks-on-upgrade changes. */
  fromVersion: z.string().optional(),
  toVersion: z.string().optional(),
  /** Header-pinned API versions (Stripe-Version, anthropic-version). */
  apiVersion: z
    .object({ header: z.string().optional(), from: z.string().optional(), to: z.string().optional() })
    .optional(),
  announcedOn: isoDate.nullable().default(null),
  effectiveOn: isoDate.nullable().default(null),
  environment: z
    .object({ markers: z.string().optional(), cfg: z.string().optional(), platform: z.string().optional() })
    .optional(),
});
export type Applicability = z.infer<typeof applicability>;

const arity = z.object({
  minBefore: z.number().int(),
  maxBefore: z.number().int(),
  minAfter: z.number().int(),
  maxAfter: z.number().int(),
});

/** What code must contain to be affected. Never bare parameter names (round-2 review). */
export const signature = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("symbol"),
    lang: z.enum(["ts", "py", "jvm", "go", "rust", "ruby"]),
    /** Stable join key with the locator: declaration file/module + qualified name. */
    declKey: z.string().min(1),
    path: z.string().min(1),
    memberKind: z.enum([
      "class",
      "method",
      "function",
      "property",
      "type",
      "const",
      "module",
      "field",
      "variable",
    ]),
    before: z.string().optional(),
    after: z.string().optional(),
    arity: arity.optional(),
  }),
  z.object({
    kind: z.literal("call-arg"),
    callee: z.array(z.string().min(1)).min(1),
    arg: z.string().min(1),
    position: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("string-literal"),
    value: z.string().min(1),
    context: z.enum(["llm-call-arg", "config", "any"]),
  }),
  z.object({
    kind: z.literal("http-operation"),
    method: z.string().min(1),
    pathPattern: z.string().min(1),
    hostPattern: z.string().min(1),
    operationId: z.string().optional(),
  }),
  z.object({ kind: z.literal("import-path"), value: z.string().min(1) }),
  z.object({ kind: z.literal("cargo-feature"), name: z.string().min(1) }),
  z.object({
    kind: z.literal("hash-key"),
    key: z.string().min(1),
    calleeConstants: z.array(z.string()).min(1),
  }),
]);
export type Signature = z.infer<typeof signature>;

export const trustBases = [
  "registry",
  "source-repo",
  "official-domain",
  "advisory-db",
  "computed",
  "repo-config",
] as const;

export const sourceRefV2 = z.object({
  url: z.url(),
  /** Where the request ended after redirects, each hop checked by the guarded fetch. */
  finalUrl: z.url().optional(),
  kind: z.enum([
    "registry",
    "surface-diff",
    "advisory",
    "openapi-diff",
    "release-notes",
    "changelog",
    "migration-guide",
    "provider-table",
    "vendor-page",
    "repo-declared",
  ]),
  trustBasis: z.enum(trustBases),
  /** Exact text from the source; required for prose and tables, absent for computed diffs. */
  quote: z.string().min(1).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.iso.datetime(),
  tool: z.object({ name: z.string(), version: z.string() }).optional(),
});
export type SourceRefV2 = z.infer<typeof sourceRefV2>;

export const provenance = z.object({
  method: z.enum(["tool", "table", "feed", "catalog", "model", "advisory-feed"]),
  tool: z
    .object({ name: z.string(), version: z.string(), noiseFilterVersion: z.string().optional() })
    .optional(),
  model: z.object({ id: z.string(), promptHash: z.string() }).optional(),
  confidence: z.object({
    overall: z.number().min(0).max(1),
    perField: z.record(z.string(), z.number().min(0).max(1)).optional(),
  }),
});

export const changeV2 = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1).max(300),
  subject,
  kind: z.enum(changeKindsV2),
  title: z.string().min(1),
  summary: z.string().min(1),
  applicability,
  signatures: z.array(signature).default([]),
  replacement: z
    .object({
      value: z.string().min(1),
      note: z.string().optional(),
      modelIds: z.array(z.string()).default([]),
      codemod: z
        .object({
          kind: z.enum([
            "rename",
            "model-swap",
            "kwarg-remove",
            "import-rewrite",
            "go-fix-inline",
            "ast-grep",
          ]),
          spec: z.unknown(),
        })
        .optional(),
    })
    .nullable()
    .default(null),
  migrationNotes: z
    .array(z.object({ text: z.string().min(1), sourceIndex: z.number().int().min(0) }))
    .default([]),
  sources: z.array(sourceRefV2).min(1),
  provenance,
  /** D53: private when any source came through a private repository. */
  visibility: z.enum(["public", "private"]),
  status: z.enum(["confirmed", "candidate", "quarantined"]),
  quarantineReasons: z.array(z.string()).default([]),
});
export type ChangeV2 = z.infer<typeof changeV2>;

export const dependencyScopes = ["prod", "dev", "test", "optional", "build", "peer"] as const;

export const dependencyInstance = z.object({
  ecosystem: z.enum(ECOSYSTEMS),
  name: z.string().min(1),
  /** npm alias, Cargo `package =` rename, and similar; the code imports this name. */
  aliasName: z.string().optional(),
  /** Exact resolved version, or null when it can't be determined (never guessed, rule 12). */
  version: z.string().nullable(),
  declaredRange: z.string().optional(),
  direct: z.boolean(),
  scope: z.enum(dependencyScopes),
  /** Importer path / module / crate / Gradle project; "." for the root. */
  workspace: z.string().min(1),
  manifestPath: z.string().min(1),
  lockfilePath: z.string().optional(),
  source: z.enum(["registry", "git", "path", "workspace", "private-index", "unknown"]),
  sourceRef: z.string().optional(),
  resolvedBy: z.enum(["lockfile", "sandbox", "unresolved"]),
  unresolvedReason: z.string().optional(),
  environment: z.object({ markers: z.string().optional(), platform: z.string().optional() }).optional(),
});
export type DependencyInstance = z.infer<typeof dependencyInstance>;

/** Stable across scans: a finding follows the dependency, not one scan's row. */
export function dependencyKey(d: Pick<DependencyInstance, "ecosystem" | "name" | "workspace">) {
  return `${d.ecosystem}:${d.name}@${d.workspace}`;
}

/** One PR per package and target (rule 9, D70). */
export function groupKey(ecosystem: Ecosystem, name: string, target: string) {
  return `${ecosystem}/${name}/${target}`;
}

export const verdicts = [
  "affected",
  "not_affected",
  "not_applicable",
  "needs_human",
  "inconclusive",
  "check_by_hand",
] as const;
export type Verdict = (typeof verdicts)[number];

/** D74: honest reachability; "not reachable" only with stated coverage. */
export const reachabilityLevels = [
  "package-present",
  "function-reachable",
  "function-not-reachable",
  "reachability-unknown",
] as const;
export type Reachability = (typeof reachabilityLevels)[number];

export const callSite = z.object({
  file: z.string().min(1),
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  kind: z.enum([
    "call",
    "property",
    "import",
    "type-ref",
    "new",
    "literal",
    "config",
    "test",
    "docs",
    "dynamic",
  ]),
  snippet: z.string(),
  resolution: z.enum(["type", "import", "traced", "name-only", "literal"]),
  declKey: z.string().optional(),
});
export type CallSite = z.infer<typeof callSite>;

export const coverage = z.object({
  filesScanned: z.number().int().min(0),
  filesSkipped: z.array(z.object({ reason: z.string(), count: z.number().int().min(0) })).default([]),
  languages: z.array(z.string()),
  resolutionLevel: z.enum(["type", "import", "syntax"]),
  unresolvedSites: z.number().int().min(0).default(0),
  transitiveAnalysed: z.boolean(),
  sourcesFreshAt: z.iso.datetime().optional(),
});
export type Coverage = z.infer<typeof coverage>;

export interface TestCounts {
  collected: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
}

export interface RunEvidence {
  kind: EvidenceKind;
  baseline: TestCounts | null;
  after: TestCounts | null;
  egressDenied: { phase: string; method: string; host: string }[];
  envDifferences: string[];
}

/** JSON Schemas published in catalog/schema/ (regenerated in CI). */
export function contractJsonSchemas() {
  return {
    "change-v2": z.toJSONSchema(changeV2, { target: "draft-2020-12", io: "input" }),
    "dependency-instance": z.toJSONSchema(dependencyInstance, { target: "draft-2020-12", io: "input" }),
  };
}
