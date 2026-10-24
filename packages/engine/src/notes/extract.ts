import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { normalizeForQuote } from "../catalog/markdown";
import { sha256 } from "../catalog/source";
import { NOTES } from "../constants";
import { type ChangeV2, changeV2 } from "../contract";
import { type ModelPrice, nemotronOptions, nemotronSampling, receiptFor, type TokenFactory } from "../llm";
import type { NoteSource } from "./sources";

/**
 * Nemotron 3 Ultra reads the sliced notes (card C2, D46): only to catch what the type diff cannot
 * see (behaviour, defaults, runtime requirements) and to pair removed APIs with their replacements
 * for the fix. Every item must quote one document verbatim; code checks the quote against the text
 * that was fetched, and anything that fails is dropped with its reason. What passes is a candidate
 * record, never confirmed by the model alone (rule 12).
 */
const NOTABLE =
  /breaking|BREAKING|\bremov|deprecat|renam|no longer|must now|now requires?|migrat|drop(?:ped|s)? support|minimum|Node(?:\.js)? \d|default(?:s)? (?:to|changed|is now)|replac/i;

/** Markdown as plain text: fence lines, heading, list and quote markers and emphasis go; words stay. */
function plain(text: string) {
  return normalizeForQuote(
    text
      .split("\n")
      .filter((line) => !/^\s*(```|~~~)/.test(line))
      .map((line) => line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s?|\d+\.\s+)/, ""))
      .join("\n")
      .replace(/\*\*|__/g, ""),
  );
}

/**
 * The quote gate for prose (D40). The quote must be in the fetched text once both are read as plain
 * text. When it skips text (marked "…" or not), every sentence must be found in order, and the
 * stored quote shows "…" at each gap, so what a PR displays is exactly what the source says.
 * Returns the quote to store, or null.
 */
export function quoteInSource(quote: string, source: string): string | null {
  const haystack = plain(source);
  const q = plain(quote);
  if (q.length >= 12 && haystack.includes(q)) return q;
  const parts = q
    .split(/\s*(?:\.\.\.|…)\s*|(?<=[.!?:;])\s+(?=[A-Z`/([])/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (!parts.length || parts.every((p) => p.length < 12)) return null;
  let from = 0;
  let out = "";
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at === -1) return null;
    out += out ? (at === from || haystack.slice(from, at).trim() === "" ? " " : " … ") : "";
    out += part;
    from = at + part.length;
  }
  return out;
}

/** `client.files.del` → `del`; `fetchOptions.dispatcher` → `dispatcher`. */
const tail = (name: string) =>
  name
    .replace(/\(\)$/, "")
    .split(/[.\s/]/)
    .filter(Boolean)
    .at(-1) ?? name;

export interface NoteDocument {
  index: number;
  title: string;
  source: NoteSource;
  text: string;
}

/** What reaches the model: migration guides whole, major entries whole, other entries' notable lines. */
export function documentsForReading(sources: NoteSource[]): NoteDocument[] {
  const docs: NoteDocument[] = [];
  let budget = NOTES.maxCharsToModel;
  const push = (title: string, source: NoteSource, text: string) => {
    const clipped = text.slice(0, Math.min(budget, NOTES.maxCharsPerDocument));
    if (!clipped.trim() || budget <= 0) return;
    budget -= clipped.length;
    docs.push({ index: docs.length, title, source, text: clipped });
  };
  for (const s of sources.filter((x) => x.kind === "migration-guide")) push("Migration guide", s, s.text);
  for (const s of sources.filter((x) => x.kind !== "migration-guide")) {
    for (const entry of s.entries ?? []) {
      const major = /^\d+\.0\.0$/.test(entry.version);
      const body = major
        ? entry.body
        : entry.body
            .split("\n")
            .filter((line) => NOTABLE.test(line))
            .join("\n");
      if (body.trim())
        push(`${s.kind === "release-notes" ? "Release" : "Changelog"} ${entry.version}`, s, body);
    }
  }
  return docs;
}

const itemSchema = z.object({
  kind: z.enum([
    "behaviour-change",
    "default-change",
    "requirement-change",
    "removal",
    "rename",
    "parameter-change",
    "migration-step",
  ]),
  summary: z.string().describe("One sentence for a developer upgrading, in plain words."),
  apis: z
    .array(z.string())
    .max(8)
    .describe(
      "At most 8 API names exactly as the quote writes them, e.g. client.beta.chat.completions.parse",
    ),
  replacement: z
    .string()
    .nullable()
    .describe("The API or setting to use instead, exactly as the quote writes it, or null"),
  quote: z
    .string()
    .describe(
      'One contiguous passage copied verbatim from one document, at most 400 characters; " … " between two passages',
    ),
  document: z.number().int().describe("Index of the document the quote is copied from"),
});
const extractionSchema = z.object({ items: z.array(itemSchema) });
export type NoteItem = z.infer<typeof itemSchema>;

const SYSTEM = `You read release notes for a developer upgrading a dependency. List only changes they must act on:
- behaviour or default changes the type declarations cannot show,
- new runtime requirements (Node.js version, peer packages, environment),
- removed or renamed APIs, each with its replacement when the notes give one,
- concrete migration steps.
Rules: one item per distinct change (group many APIs changed the same way into one item, naming at most 8 of them); every item quotes one contiguous passage of one document verbatim (copy the characters exactly, at most 400; if the evidence sits in two places, join them with " … ") and names that document's index. Never invent APIs, versions or replacements the quote does not contain. Skip bug fixes, internal chores, docs and new features that need no action. Return an empty list when nothing applies.`;

export interface ExtractionResult {
  items: (NoteItem & { source: NoteSource })[];
  dropped: { item: NoteItem; reason: string }[];
  receipt: {
    step: "notes";
    model: string;
    tokensIn: number;
    tokensCached: number;
    tokensOut: number;
    costUsd: number;
    ms: number;
  };
  promptHash: string;
  error?: string;
}

export async function extractNotes(
  tf: TokenFactory,
  docs: NoteDocument[],
  context: { name: string; from: string; to: string; removedApis: string[] },
  prices?: Map<string, ModelPrice>,
): Promise<ExtractionResult> {
  const started = Date.now();
  // Static instructions first, documents next, the per-run question last: prefix caching works.
  const prompt = [
    ...docs.map((d) => `<document index="${d.index}" title="${d.title}">\n${d.text}\n</document>`),
    `Upgrade: ${context.name} ${context.from} → ${context.to}.`,
    context.removedApis.length
      ? `The type diff already found these removed or changed APIs (find their replacements if the notes give them): ${context.removedApis.slice(0, NOTES.maxRemovedApisInPrompt).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const promptHash = sha256(`${SYSTEM}\n${prompt}`);
  const modelId = tf.modelId("reader");
  const items: ExtractionResult["items"] = [];
  const dropped: ExtractionResult["dropped"] = [];
  let output: z.infer<typeof extractionSchema>;
  let usage: Parameters<typeof receiptFor>[0];
  try {
    const result = await generateText({
      model: tf.model("reader"),
      system: SYSTEM,
      prompt,
      output: Output.object({ schema: extractionSchema }),
      maxOutputTokens: NOTES.maxOutputTokens,
      ...nemotronSampling,
      providerOptions: nemotronOptions({ thinking: false }),
    });
    output = result.output;
    usage = result.usage;
  } catch (error) {
    // An answer that does not parse is recorded, paid for, and yields nothing (never a guess).
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    return {
      items,
      dropped,
      promptHash,
      error: `the model's answer did not match the schema (${error.finishReason ?? "unknown"})`,
      receipt: {
        step: "notes",
        model: modelId,
        ...receiptFor(error.usage ?? ({} as Parameters<typeof receiptFor>[0]), prices?.get(modelId)),
        ms: Date.now() - started,
      },
    };
  }
  for (const item of output.items) {
    // The quote decides: verbatim in the document the model names, or in any other document read.
    let doc: NoteDocument | undefined;
    let verified: string | null = null;
    for (const d of [docs[item.document], ...docs]) {
      verified = d ? quoteInSource(item.quote, d.source.text) : null;
      if (verified) {
        doc = d;
        break;
      }
    }
    if (!doc || !verified) {
      dropped.push({ item, reason: "quote not found in the fetched text" });
      continue;
    }
    // Names the quote does not contain are removed; the item stands on its quote.
    const quoted = verified;
    const apis = item.apis.filter((name) => quoted.includes(tail(name)));
    const spans = [...(item.replacement ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
    const replacement =
      item.replacement &&
      (spans.length ? spans.every((sp) => quoted.includes(sp)) : quoted.includes(item.replacement))
        ? item.replacement
        : null;
    items.push({ ...item, quote: verified, apis, replacement, document: doc.index, source: doc.source });
  }
  return {
    items,
    dropped,
    promptHash,
    receipt: {
      step: "notes",
      model: modelId,
      ...receiptFor(usage, prices?.get(modelId)),
      ms: Date.now() - started,
    },
  };
}

/** Behaviour, default and requirement changes become candidate records; the rest guide the fix. */
export function noteRecords(
  extraction: ExtractionResult,
  context: { name: string; from: string; to: string },
): ChangeV2[] {
  return extraction.items
    .filter(
      (i) => i.kind === "behaviour-change" || i.kind === "default-change" || i.kind === "requirement-change",
    )
    .map((i) =>
      changeV2.parse({
        schemaVersion: 2,
        id: `npm/${context.name}/${context.from}..${context.to}/notes/${sha256(i.quote).slice(0, 12)}`,
        subject: { kind: "package", ecosystem: "npm", name: context.name },
        kind: "behaviour-change",
        title: i.summary.slice(0, 200),
        summary: i.summary,
        applicability: {
          class: "breaks-on-upgrade",
          affectedRange: context.from,
          fromVersion: context.from,
          toVersion: context.to,
        },
        sources: [
          {
            url: i.source.url,
            kind:
              i.source.kind === "release-notes"
                ? "release-notes"
                : i.source.kind === "migration-guide"
                  ? "migration-guide"
                  : "changelog",
            trustBasis: i.source.trustBasis,
            quote: i.quote,
            contentHash: i.source.contentHash,
            checkedAt: i.source.checkedAt,
          },
        ],
        provenance: {
          method: "model",
          model: { id: extraction.receipt.model, promptHash: extraction.promptHash },
          confidence: { overall: 0.6 },
        },
        visibility: "public",
        status: "candidate",
      }),
    );
}

/** Removals, renames and steps with their quotes: what the fix agent reads alongside the diff. */
export function migrationNotes(extraction: ExtractionResult) {
  return extraction.items
    .filter(
      (i) =>
        i.kind === "removal" ||
        i.kind === "rename" ||
        i.kind === "parameter-change" ||
        i.kind === "migration-step",
    )
    .map((i) => ({
      summary: i.summary,
      apis: i.apis,
      replacement: i.replacement,
      quote: i.quote,
      url: i.source.url,
    }));
}
