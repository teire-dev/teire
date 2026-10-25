/**
 * Small, strict readers for the markdown that providers publish (OpenAI, Anthropic and Token Factory
 * serve `.md`; Gemini serves `.md.txt`). Tables are always read by code, never by a model (plan D40).
 */

export interface Section {
  level: number;
  heading: string;
  /** Text under the heading, up to the next heading of the same or a higher level. */
  body: string;
}

/** Splits markdown into sections at headings of exactly `level`. Code fences are not treated as headings. */
export function sections(markdown: string, level: number): Section[] {
  const lines = markdown.split("\n");
  const out: Section[] = [];
  let current: Section | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (match && (match[1] ?? "").length <= level) {
      if (current) out.push(current);
      current = (match[1] ?? "").length === level ? { level, heading: match[2] ?? "", body: "" } : null;
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) out.push(current);
  return out;
}

export interface Table {
  header: string[];
  rows: Row[];
}

export interface Row {
  cells: string[];
  /** The row exactly as published, used as the record's quote. */
  raw: string;
}

/** Splits a table line on unescaped pipes. `\|` stays inside the cell (OpenAI uses it between aliases). */
function splitRow(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

const isDivider = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);

/** Every pipe table in `text`, header row plus body rows. */
export function tables(text: string): Table[] {
  const lines = text.split("\n");
  const out: Table[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const head = lines[i] ?? "";
    if (!head.trim().startsWith("|") || !isDivider(lines[i + 1] ?? "")) continue;
    const table: Table = { header: splitRow(head).map(plain), rows: [] };
    let j = i + 2;
    for (; j < lines.length && (lines[j] ?? "").trim().startsWith("|"); j++) {
      const raw = (lines[j] ?? "").trim();
      table.rows.push({ cells: splitRow(raw), raw });
    }
    out.push(table);
    i = j - 1;
  }
  return out;
}

/** Cell text without markdown: links keep their label, emphasis and backticks are dropped. */
export function plain(cell: string) {
  return (
    cell
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`/g, "")
      // Emphasis only: underscores inside identifiers (Nemotron-3_5) stay.
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=$|[\s).,;:])/g, "$1$2")
      .replace(/\\\|/g, "|")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Backticked identifiers in a cell, in order, without duplicates (`gpt-4-0613` \| `gpt-4` → both). */
export function codeSpans(cell: string) {
  const ids = [...cell.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
  return [...new Set(ids)];
}

/** Index of the first header cell matching any pattern, or -1. */
export function column(header: string[], ...patterns: RegExp[]) {
  return header.findIndex((cell) => patterns.some((p) => p.test(cell)));
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * First calendar date in `text` as YYYY-MM-DD: "October 23, 2026", "Aug 10, 2026", "2026-10-23".
 * Returns null for "No shutdown date announced", "N/A", "To be announced" and anything else without a date.
 */
export function isoDate(input: string): string | null {
  // OpenAI writes some dates with non-breaking hyphens (2026‑05‑12).
  const text = input.replace(/[\u2010-\u2015\u2212]/g, "-");
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named =
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(text);
  if (!named) return null;
  const month = MONTHS[(named[1] ?? "").slice(0, 3).toLowerCase()];
  if (!month) return null;
  return `${named[3]}-${String(month).padStart(2, "0")}-${(named[2] ?? "").padStart(2, "0")}`;
}

/** Same text with whitespace collapsed and markdown escapes removed, for quote checks. */
export function normalizeForQuote(text: string) {
  return text
    .replace(/\\([|*_`[\]()])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `quote` appears in `source` once both are normalised (plan D40: quotes are checked by code). */
export function quoteAppearsIn(quote: string, source: string) {
  const q = normalizeForQuote(quote);
  if (q.length === 0) return false;
  const text = normalizeForQuote(source);
  if (text.includes(q)) return true;
  // A quote that skips text shows " … " at each gap; every part must be there, in order.
  if (q.includes(" … ")) {
    let from = 0;
    for (const part of q.split(" … ")) {
      const at = text.indexOf(part, from);
      if (!part || at === -1) return false;
      from = at + part.length;
    }
    return true;
  }
  // Registry responses are JSON: compare against the decoded string values too.
  const decoded = jsonStrings(source);
  return decoded !== null && normalizeForQuote(decoded).includes(q);
}

function jsonStrings(body: string): string | null {
  const first = body.trimStart()[0];
  if (first !== "{" && first !== "[") return null;
  try {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(JSON.parse(body));
    return out.join("\n");
  } catch {
    return null;
  }
}
