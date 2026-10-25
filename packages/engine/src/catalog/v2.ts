import {
  type ApplicabilityClass,
  type ChangeKindV2,
  type ChangeV2,
  changeV2,
  type Signature,
  type SourceRefV2,
} from "../contract";
import { isoDate, normalizeForQuote, quoteAppearsIn } from "./markdown";
import type { ChangeRecord, ProviderRecord } from "./schema";

/**
 * Provider-table rows in contract v2 (plan S04): the precision readers keep reading their tables
 * into rows; this turns each row into a v2 change at the ingest boundary, and the gate checks the
 * v2 record. Ids stay as they were (`openai-2026-10-23-gpt-4-0613`) so links and findings keep
 * pointing at the same change.
 *
 * Signatures:
 *  - model IDs → string literals passed to an LLM call;
 *  - endpoints → HTTP operations on the provider's API host (any method: the tables give paths);
 *  - parameters → arguments of the provider's own LLM calls (`detection.calls`); a provider with
 *    none (Stripe's field names) gets no parameter signature, because a bare name would match any
 *    code (round-2 review); Stripe's version-pinned changes are matched through its OpenAPI spec.
 */
const MODEL_ID = /^[A-Za-z0-9][\w./:@+-]*$/;

/** v1 kind → v2 kind (only `sdk-major` was renamed). */
const KIND: Record<ChangeRecord["kind"], ChangeKindV2> = {
  "model-retirement": "model-retirement",
  "model-rerouted": "model-rerouted",
  "api-version-sunset": "api-version-sunset",
  "parameter-change": "parameter-change",
  "endpoint-removal": "endpoint-removal",
  "sdk-major": "package-major",
  "behaviour-change": "behaviour-change",
  "account-gated": "account-gated",
  "package-deprecated": "package-deprecated",
};

const SOURCE_KIND: Record<ProviderRecord["sources"][number]["kind"], SourceRefV2["kind"]> = {
  deprecations: "provider-table",
  changelog: "changelog",
  "release-feed": "release-notes",
  "model-catalog": "provider-table",
  "notices-index": "vendor-page",
  "package-registry": "registry",
  custom: "vendor-page",
};

/**
 * When the change bites. Dated shutdowns are already broken once the date has passed and break on
 * that date before it; version-pinned changes (Stripe, Anthropic API versions) break when the repo
 * moves to that version; a reroute or an undated deprecation breaks nothing yet (D76).
 */
function classOf(record: ChangeRecord, today: string): ApplicabilityClass {
  if (
    record.kind === "model-rerouted" ||
    record.kind === "account-gated" ||
    record.kind === "package-deprecated"
  )
    return "notice";
  if (
    record.signatures.apiVersions.length &&
    (record.kind === "parameter-change" || record.kind === "behaviour-change")
  )
    return "breaks-on-upgrade";
  if (record.kind === "sdk-major") return "breaks-on-upgrade";
  if (!record.effectiveOn) return record.kind === "behaviour-change" ? "breaks-on-upgrade" : "notice";
  return record.effectiveOn <= today ? "already-broken" : "breaks-on-date";
}

function subjectOf(record: ChangeRecord, provider: ProviderRecord): ChangeV2["subject"] {
  if (record.kind === "model-retirement" || record.kind === "model-rerouted")
    return { kind: "model", name: record.signatures.modelIds[0] ?? record.title, provider: provider.slug };
  const pkg = record.signatures.packages[0];
  if ((record.kind === "sdk-major" || record.kind === "package-deprecated") && pkg)
    return { kind: "package", ecosystem: pkg.ecosystem, name: pkg.name, provider: provider.slug };
  const host = provider.detection.baseUrls[0] ?? new URL(provider.homepage).hostname;
  return { kind: "api-host", name: host, provider: provider.slug };
}

function signaturesOf(record: ChangeRecord, provider: ProviderRecord): Signature[] {
  const out: Signature[] = [];
  for (const value of record.signatures.modelIds)
    out.push({ kind: "string-literal", value, context: "llm-call-arg" });
  const host = provider.detection.baseUrls[0];
  if (host)
    for (const path of record.signatures.endpoints)
      out.push({ kind: "http-operation", method: "*", pathPattern: path, hostPattern: host });
  if (provider.detection.calls.length)
    for (const arg of record.signatures.params)
      out.push({ kind: "call-arg", callee: provider.detection.calls, arg });
  return out;
}

/** A source the scanned repo named in its teire.yml: its trust is the repo's own, and it stays private (D53). */
export const declaredByRepo = (provider: ProviderRecord) =>
  provider.discovery?.via.includes("teire.yml") ?? false;

function sourcesOf(record: ChangeRecord, provider: ProviderRecord): SourceRefV2[] {
  const listed = new Map(provider.sources.map((s) => [s.url, SOURCE_KIND[s.kind]]));
  const declared = declaredByRepo(provider);
  return record.sources.map((s) => ({
    url: s.url,
    // A page linked from the provider's index (a Stripe change page, a Token Factory notice).
    kind: declared
      ? "repo-declared"
      : (listed.get(s.url) ?? (provider.sources[0]?.kind === "changelog" ? "changelog" : "vendor-page")),
    trustBasis: declared ? "repo-config" : "official-domain",
    quote: s.quote,
    contentHash: s.contentHash,
    checkedAt: s.checkedAt,
  }));
}

/** The source each migration note is quoted from: the first whose quote contains it. */
function notesOf(record: ChangeRecord) {
  return record.migrationNotes
    .filter((text) => text.trim())
    .map((text) => {
      const index = record.sources.findIndex((s) =>
        normalizeForQuote(s.quote).includes(normalizeForQuote(text)),
      );
      return { text, sourceIndex: Math.max(0, index) };
    });
}

export function toChangeV2(record: ChangeRecord, provider: ProviderRecord, now = new Date()): ChangeV2 {
  const today = now.toISOString().slice(0, 10);
  const replacementIds = (record.replacement?.modelIds ?? []).filter((id) => MODEL_ID.test(id));
  const [from] = record.signatures.modelIds;
  const swap =
    record.kind === "model-retirement" && from && replacementIds.length === 1
      ? { kind: "model-swap" as const, spec: { from: record.signatures.modelIds, to: replacementIds[0] } }
      : undefined;
  const apiVersion = record.signatures.apiVersions[0];
  return changeV2.parse({
    schemaVersion: 2,
    id: record.id,
    subject: subjectOf(record, provider),
    kind: KIND[record.kind],
    title: record.title,
    // An empty summary means the reader found no text it understands (a translated or redesigned
    // page): the record is kept, visible and quarantined, never applied.
    summary: record.summary.trim() || record.title,
    applicability: {
      class: classOf(record, today),
      announcedOn: record.announcedOn,
      effectiveOn: record.effectiveOn,
      ...(apiVersion
        ? {
            apiVersion: {
              ...(provider.apiVersionHeader ? { header: provider.apiVersionHeader } : {}),
              to: apiVersion,
            },
          }
        : {}),
    },
    signatures: signaturesOf(record, provider),
    replacement: record.replacement
      ? {
          value: record.replacement.value,
          ...(record.replacement.note ? { note: record.replacement.note } : {}),
          modelIds: replacementIds,
          ...(swap ? { codemod: swap } : {}),
        }
      : null,
    migrationNotes: notesOf(record),
    sources: sourcesOf(record, provider),
    provenance: {
      method: record.extraction.method,
      ...(record.extraction.model ? { model: { id: record.extraction.model, promptHash: "" } } : {}),
      confidence: {
        overall: record.status === "confirmed" ? (record.extraction.method === "model" ? 0.8 : 1) : 0.3,
      },
    },
    visibility: declaredByRepo(provider) ? "private" : "public",
    status: record.summary.trim() ? record.status : "quarantined",
    quarantineReasons: [
      ...record.quarantineReasons,
      ...(record.summary.trim() ? [] : ["No summary text was read from the source page."]),
    ],
  });
}

/**
 * The quarantine gate on a v2 provider record. Every record, however it was read, must:
 *   1. match the schema;
 *   2. cite only the provider's own domains;
 *   3. quote text that is really in the fetched page (checked by code, plan D40);
 *   4. when a model read it, show every identifier and the date inside its quotes.
 * A record that fails stays visible as "unconfirmed" and is never applied to code.
 */
export function gateV2(
  record: ChangeV2,
  provider: ProviderRecord,
  bodies: ReadonlyMap<string, string>,
): ChangeV2 {
  const reasons: string[] = [];
  const parsed = changeV2.safeParse(record);
  if (!parsed.success)
    reasons.push(`Schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);

  for (const source of record.sources) {
    const host = safeHost(source.url);
    if (!host || !provider.officialDomains.some((d) => host === d || host.endsWith(`.${d}`)))
      reasons.push(`Source ${source.url} is not on ${provider.name}'s own domains.`);
    const body = bodies.get(source.url);
    if (body === undefined) reasons.push(`Source ${source.url} was not fetched in this run.`);
    else if (!source.quote || !quoteAppearsIn(source.quote, body))
      reasons.push(`Quote not found in ${source.url}.`);
  }

  if (record.provenance.method === "model") {
    const quotes = normalizeForQuote(record.sources.map((s) => s.quote ?? "").join("\n"));
    const named = [
      ...record.signatures.flatMap((s) =>
        s.kind === "string-literal"
          ? [s.value]
          : s.kind === "call-arg"
            ? [s.arg]
            : s.kind === "http-operation"
              ? [s.pathPattern]
              : [],
      ),
      ...(record.replacement?.modelIds ?? []),
    ];
    for (const id of named) if (!quotes.includes(id)) reasons.push(`"${id}" does not appear in the quotes.`);
    const effective = record.applicability.effectiveOn;
    if (effective && !record.sources.some((s) => datesIn(s.quote ?? "").includes(effective)))
      reasons.push(`The date ${effective} does not appear in the quotes.`);
  }

  const merged = [...new Set([...record.quarantineReasons, ...reasons])];
  return { ...record, status: merged.length ? "quarantined" : record.status, quarantineReasons: merged };
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const validDay = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

/**
 * Every date a quote states, in ISO form: ISO, "August 16, 2026", "16 August 2026", and numeric
 * `MM/DD/YY(YY)` (Groq) or `DD/MM/YYYY`. A numeric date both readings allow yields both; the gate
 * only asks that the record's date is one of them.
 */
export function datesIn(text: string) {
  const out = new Set<string>();
  // OpenAI writes some dates with non-breaking hyphens (2026‑05‑12).
  const plain = text.replace(/[\u2010-\u2015\u2212]/g, "-");
  for (const m of plain.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) out.add(m[0]);
  for (const m of plain.matchAll(
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi,
  )) {
    const date = isoDate(m[0]);
    if (date) out.add(date);
  }
  for (const m of text.matchAll(
    /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(\d{4})\b/gi,
  )) {
    const month = MONTH_NAMES.indexOf((m[2] ?? "").slice(0, 3).toLowerCase()) + 1;
    const [y, d] = [Number(m[3]), Number(m[1])];
    if (month && validDay(y, month, d)) out.add(`${y}-${pad(month)}-${pad(d)}`);
  }
  for (const m of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const y = (m[3] ?? "").length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (validDay(y, a, b)) out.add(`${y}-${pad(a)}-${pad(b)}`);
    if (validDay(y, b, a)) out.add(`${y}-${pad(b)}-${pad(a)}`);
  }
  return [...out];
}
