import { z } from "zod";

/** Bump when a record's shape changes; readers reject records with a newer version. */
export const CATALOG_SCHEMA_VERSION = 1;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const changeKinds = [
  "model-retirement",
  "model-rerouted",
  "api-version-sunset",
  "parameter-change",
  "endpoint-removal",
  "sdk-major",
  "behaviour-change",
  "account-gated",
  "package-deprecated",
] as const;
export type ChangeKind = (typeof changeKinds)[number];

/** Where a record came from. Every record carries at least one, with the provider's own words. */
export const sourceRef = z.object({
  url: z.url(),
  /** Exact text from the source that states the change (a table row, a sentence). */
  quote: z.string().min(1),
  /** sha256 of the fetched source body this quote was read from. */
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.iso.datetime(),
});
export type SourceRef = z.infer<typeof sourceRef>;

const packageRef = z.object({
  ecosystem: z.enum(["npm", "pypi"]),
  name: z.string().min(1),
  /** Semver range the change applies to, when the source gives one. */
  versions: z.string().optional(),
});

/** What code would have to contain to be affected. Used to build search signatures in scans. */
export const signatures = z.object({
  modelIds: z.array(z.string().min(1)).default([]),
  params: z.array(z.string().min(1)).default([]),
  endpoints: z.array(z.string().min(1)).default([]),
  symbols: z.array(z.string().min(1)).default([]),
  packages: z.array(packageRef).default([]),
  apiVersions: z.array(z.string().min(1)).default([]),
});
export type Signatures = z.infer<typeof signatures>;

export const changeRecord = z.object({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  /** `<provider>-<effective or announced date>-<subject>`, stable across re-ingestion. */
  id: slug,
  provider: slug,
  kind: z.enum(changeKinds),
  title: z.string().min(1),
  summary: z.string().min(1),
  announcedOn: isoDate.nullable(),
  /** When old behaviour stops working. Null when the provider has not set one. */
  effectiveOn: isoDate.nullable(),
  breaking: z.boolean(),
  signatures,
  /** What to move to, verbatim from the provider. Null when the provider names none. */
  replacement: z
    .object({
      value: z.string().min(1),
      /** Provider's own qualifier, e.g. "reasoning.mode: pro" or a routing note. */
      note: z.string().optional(),
      /** Model IDs inside `value`, for codemods. */
      modelIds: z.array(z.string()).default([]),
    })
    .nullable(),
  /** Extra steps the provider says the move needs (coupled parameters, behaviour notes). */
  migrationNotes: z.array(z.string()).default([]),
  sources: z.array(sourceRef).min(1),
  /** How the fields were read: by code from a table/feed/catalog, or by a model from prose. */
  extraction: z.object({
    method: z.enum(["table", "feed", "catalog", "model"]),
    model: z.string().optional(),
  }),
  status: z.enum(["confirmed", "quarantined"]),
  /** Why a record is quarantined; empty when confirmed. */
  quarantineReasons: z.array(z.string()).default([]),
});
export type ChangeRecord = z.infer<typeof changeRecord>;

export const providerSourceKinds = [
  "deprecations",
  "changelog",
  "release-feed",
  "model-catalog",
  "notices-index",
  "package-registry",
  "custom",
] as const;

export const providerRecord = z.object({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  slug,
  name: z.string().min(1),
  homepage: z.url(),
  /** Paths under the web app's /public, light and dark variants. */
  logo: z.object({ light: z.string().min(1), dark: z.string().min(1) }),
  /** Domains whose pages count as the provider's own words (the quarantine gate checks this). */
  officialDomains: z.array(z.string().min(1)).min(1),
  sources: z
    .array(
      z.object({
        kind: z.enum(providerSourceKinds),
        url: z.url(),
        /** Adapter that reads this source. */
        adapter: z.string().min(1),
      }),
    )
    .min(1),
  sdks: z.array(packageRef).default([]),
  /** How a repository shows it uses this provider. */
  detection: z.object({
    imports: z.array(z.string()).default([]),
    envVars: z.array(z.string()).default([]),
    baseUrls: z.array(z.string()).default([]),
    /**
     * Member chains of the SDK calls that send a request with a model and sampling parameters
     * (`chat.completions.create`, `messages.create`); a removed parameter is matched only on these.
     */
    calls: z.array(z.string()).default([]),
  }),
  /** Header that pins the API version a request is served under (`Stripe-Version`). */
  apiVersionHeader: z.string().optional(),
});
export type ProviderRecord = z.infer<typeof providerRecord>;

/** Lowercase, dash-separated, safe for ids and file names ("nvidia/Nemotron-3_5" → "nvidia-nemotron-3-5"). */
export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function changeId(provider: string, date: string | null, subject: string) {
  return [provider, date ?? "undated", slugify(subject)].join("-").slice(0, 120).replace(/-+$/, "");
}

/**
 * JSON Schemas published in catalog/ and at /schema/*.json. Change records are contract v2
 * (`change-v2.schema.json`, from contract.ts); `changeRecord` above is only the row shape the
 * precision readers produce before conversion.
 */
export function catalogJsonSchemas() {
  return { provider: z.toJSONSchema(providerRecord, { target: "draft-2020-12", io: "input" }) };
}
