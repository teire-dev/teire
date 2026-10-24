import { isoDate, normalizeForQuote, quoteAppearsIn } from "./markdown";
import { type ChangeRecord, changeRecord, type ProviderRecord } from "./schema";

/**
 * The quarantine gate. Every record, however it was read, must:
 *   1. match the schema;
 *   2. cite only the provider's own domains;
 *   3. quote text that is really in the fetched page (checked by code, plan D40);
 *   4. when a model read it, show every identifier and the date inside its quotes.
 * A record that fails stays visible as "unconfirmed" and is never applied to code.
 */
export function gate(record: ChangeRecord, provider: ProviderRecord, bodies: ReadonlyMap<string, string>) {
  const reasons: string[] = [];

  const parsed = changeRecord.safeParse(record);
  if (!parsed.success) {
    reasons.push(`Schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }

  for (const source of record.sources) {
    const host = safeHost(source.url);
    if (!host || !provider.officialDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
      reasons.push(`Source ${source.url} is not on ${provider.name}'s own domains.`);
    }
    const body = bodies.get(source.url);
    if (body === undefined) reasons.push(`Source ${source.url} was not fetched in this run.`);
    else if (!quoteAppearsIn(source.quote, body)) reasons.push(`Quote not found in ${source.url}.`);
  }

  if (record.extraction.method === "model") {
    const quotes = normalizeForQuote(record.sources.map((s) => s.quote).join("\n"));
    const named = [
      ...record.signatures.modelIds,
      ...record.signatures.params,
      ...record.signatures.endpoints,
      ...(record.replacement?.modelIds ?? []),
    ];
    for (const id of named) if (!quotes.includes(id)) reasons.push(`"${id}" does not appear in the quotes.`);
    if (
      record.effectiveOn &&
      !record.sources.some((s) => datesIn(s.quote).includes(record.effectiveOn ?? ""))
    ) {
      reasons.push(`The date ${record.effectiveOn} does not appear in the quotes.`);
    }
  }

  const merged = [...new Set([...record.quarantineReasons, ...reasons])];
  return {
    ...record,
    status: merged.length ? "quarantined" : record.status,
    quarantineReasons: merged,
  } satisfies ChangeRecord;
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Every date a quote states, in ISO form. */
function datesIn(text: string) {
  const out: string[] = [];
  for (const piece of text.split(/[|.;\n]/)) {
    const date = isoDate(piece);
    if (date) out.push(date);
  }
  return out;
}
