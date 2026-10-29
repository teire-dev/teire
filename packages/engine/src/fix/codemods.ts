import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallSite } from "../contract";
import { readManifest, resolveSubpath } from "../surface/entries";

/**
 * Deterministic edits before the agent (card C4 step 4): only where a quoted migration note maps
 * old → new and the target proves the new side exists. Two kinds, both at type-resolved sites:
 *  - a deep import whose subpath is gone, rewritten to the path the note names that resolves in
 *    the target (`openai/resources/beta/chat/completions` → `openai/resources/chat/completions`);
 *  - a call chain the note renames (`beta.chat.completions.parse` → `chat.completions.parse`),
 *    applied only when the old chain is gone from the target surface and the new one is in it.
 */
export interface MigrationNote {
  summary: string;
  apis: string[];
  replacement: string | null;
  quote: string;
  url: string;
  /** From a changelog the repository named in its own teire.yml (S16.1). */
  declared?: boolean;
}

export interface CodemodEdit {
  file: string;
  line: number;
  before: string;
  after: string;
  reason: string;
  noteUrl: string;
}

const CHAIN = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(\s*\)/g;
const lastSegment = (chain: string) => chain.split(".").at(-1) ?? chain;
/** `client.beta.chat.completions.parse` → `beta.chat.completions.parse` (the receiver is the repo's). */
const withoutReceiver = (chain: string) => chain.split(".").slice(1).join(".");

/** Old → new call chains a note states: "Before … After …" in the quote, or apis → replacement. */
export function renamePairs(note: MigrationNote): [string, string][] {
  const pairs: [string, string][] = [];
  const before = note.quote.search(/\bBefore\b/i);
  const after = note.quote.search(/\bAfter\b/i);
  if (before !== -1 && after > before) {
    const olds = [...note.quote.slice(before, after).matchAll(CHAIN)].map((m) => m[1] ?? "");
    const news = [...note.quote.slice(after).matchAll(CHAIN)].map((m) => m[1] ?? "");
    for (const o of olds) {
      const n = news.find((x) => lastSegment(x) === lastSegment(o) && x !== o);
      if (n) pairs.push([o, n]);
    }
  }
  if (note.replacement) {
    const news = [...note.replacement.matchAll(CHAIN)].map((m) => m[1] ?? "");
    for (const api of note.apis) {
      const o = api.replace(/\(\)$/, "");
      const n = news.find((x) => lastSegment(x) === lastSegment(o) && x !== o);
      if (n && !pairs.some(([a]) => a === o)) pairs.push([o, n]);
    }
  }
  return pairs;
}

/** Bare package specifiers a quote names: `'openai/resources/chat/completions'`. */
function specifiersIn(text: string, packageName: string) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(`["'\`](${escaped}(?:/[\\w./-]+)?)["'\`]`, "g"))].map(
    (m) => m[1] ?? "",
  );
}

export function planCodemods(input: {
  repoDir: string;
  packageName: string;
  sites: CallSite[];
  notes: MigrationNote[];
  targetDir: string;
  /** Every symbol path in the target's surface. */
  targetPaths: ReadonlySet<string>;
}): CodemodEdit[] {
  const edits: CodemodEdit[] = [];
  const targetManifest = readManifest(input.targetDir) ?? {};
  const tails = [...input.targetPaths];
  const inTarget = (chain: string) => tails.some((p) => p === chain || p.endsWith(`.${chain}`));
  const lines = new Map<string, string[]>();
  const fileLines = (file: string) => {
    let l = lines.get(file);
    if (!l) {
      l = readFileSync(join(input.repoDir, file), "utf8").split("\n");
      lines.set(file, l);
    }
    return l;
  };

  for (const site of input.sites) {
    const text = fileLines(site.file)[site.line - 1];
    if (text === undefined) continue;
    if (site.kind === "import") {
      const old = site.snippet;
      for (const note of input.notes) {
        if (!note.quote.includes(old)) continue;
        const candidates = specifiersIn(note.quote, input.packageName).filter(
          (s) =>
            s !== old &&
            resolveSubpath(
              input.targetDir,
              targetManifest,
              s === input.packageName ? "." : `./${s.slice(input.packageName.length + 1)}`,
            ) !== null,
        );
        const unique = [...new Set(candidates)];
        if (unique.length !== 1 || !unique[0]) continue;
        const next: string = text.replace(old, unique[0]);
        if (next !== text)
          edits.push({
            file: site.file,
            line: site.line,
            before: text,
            after: next,
            reason: `import path ${old} → ${unique[0]}`,
            noteUrl: note.url,
          });
        break;
      }
      continue;
    }
    if (site.kind !== "call" && site.kind !== "property") continue;
    for (const note of input.notes) {
      for (const [oldChain, newChain] of renamePairs(note)) {
        const oldSuffix = withoutReceiver(oldChain);
        const newSuffix = withoutReceiver(newChain);
        if (!oldSuffix || !newSuffix || !text.includes(`.${oldSuffix}`)) continue;
        if (inTarget(oldSuffix) || !inTarget(newSuffix)) continue;
        const next: string = text.replace(`.${oldSuffix}`, `.${newSuffix}`);
        if (next !== text && !edits.some((e) => e.file === site.file && e.line === site.line))
          edits.push({
            file: site.file,
            line: site.line,
            before: text,
            after: next,
            reason: `${oldSuffix} → ${newSuffix}`,
            noteUrl: note.url,
          });
      }
    }
  }
  return edits;
}

/** Applies planned edits to the working copy; returns the files changed. */
export function applyCodemods(repoDir: string, edits: CodemodEdit[]) {
  const byFile = new Map<string, CodemodEdit[]>();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  for (const [file, list] of byFile) {
    const path = join(repoDir, file);
    const content = readFileSync(path, "utf8").split("\n");
    for (const e of list) if (content[e.line - 1] === e.before) content[e.line - 1] = e.after;
    writeFileSync(path, content.join("\n"));
  }
  return [...byFile.keys()];
}
