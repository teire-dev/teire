import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallSite, ChangeV2 } from "../contract";
import type { FindingDraft } from "../impact";
import type { CodemodEdit, MigrationNote } from "./codemods";
import { noteRenames } from "./renames";

/** A class or function the surface diff found at a new import path (`import-rewrite`). */
export interface PythonMove {
  from: string;
  to: string;
}

/** A keyword a function no longer accepts (`kwarg-remove`). */
export interface RemovedKeyword {
  callee: string;
  arg: string;
}

/**
 * Python's deterministic edits at type-resolved sites (R21.7), from the target's own surface:
 * `from a.b import X` → `from a.c import X` where griffe finds X moved (`import-rewrite`), and a
 * keyword the target's function no longer has taken out of each call that passes it
 * (`kwarg-remove`). A keyword a note renames is the rename's, not a removal. Anything else (a
 * star import, a usage through another module's name) is left to the agent.
 */
export function planPythonEdits(input: {
  repoDir: string;
  findings: readonly FindingDraft[];
  records: readonly ChangeV2[];
  notes: readonly MigrationNote[];
}): CodemodEdit[] {
  const edits: CodemodEdit[] = [];
  const texts = new Map<string, string | null>();
  const text = (file: string) => {
    if (!texts.has(file)) {
      let t: string | null = null;
      try {
        t = readFileSync(join(input.repoDir, file), "utf8");
      } catch {}
      texts.set(file, t);
    }
    return texts.get(file) ?? null;
  };
  const renamed = new Set(input.notes.flatMap((n) => noteRenames(n).map(([from]) => from)));
  const taken = (file: string, line: number, endLine: number) =>
    edits.some((e) => e.file === file && e.line <= endLine && (e.endLine ?? e.line) >= line);
  for (const f of input.findings) {
    if (f.via) continue;
    const record = input.records.find((r) => r.id === f.changeId);
    const codemod = record?.replacement?.codemod;
    if (!record || !codemod) continue;
    const url = record.sources[0]?.url ?? "";
    for (const site of f.callSites) {
      if (site.resolution !== "type" && site.resolution !== "import") continue;
      const source = text(site.file);
      if (source === null) continue;
      if (codemod.kind === "import-rewrite") {
        const move = ((codemod.spec as { moves?: PythonMove[] }).moves ?? []).find(
          (m) => m.from === site.declKey,
        );
        const edit = move && site.kind === "import" ? importRewrite(source, site, move) : null;
        if (edit && !taken(site.file, edit.line, edit.endLine ?? edit.line))
          edits.push({ ...edit, file: site.file, reason: `${move?.from} → ${move?.to}`, noteUrl: url });
      } else if (codemod.kind === "kwarg-remove" && site.kind === "call") {
        const removed = ((codemod.spec as { removed?: RemovedKeyword[] }).removed ?? []).filter(
          (r) =>
            (r.callee === site.declKey || `${r.callee}.__init__` === site.declKey) && !renamed.has(r.arg),
        );
        for (const r of removed) {
          const edit = keywordRemoval(source, site, r.arg);
          if (edit && !taken(site.file, edit.line, edit.endLine ?? edit.line)) {
            edits.push({
              ...edit,
              file: site.file,
              reason: `\`${r.arg}=\` removed: ${r.callee.split(".").at(-1)} no longer takes it`,
              noteUrl: url,
            });
            break;
          }
        }
      }
    }
  }
  return edits;
}

type LineEdit = Pick<CodemodEdit, "line" | "endLine" | "before" | "after">;

const moduleOf = (path: string) => path.slice(0, path.lastIndexOf("."));
const nameOf = (path: string) => path.slice(path.lastIndexOf(".") + 1);

/**
 * `from a.b import X` (with others, an alias, or parenthesised over several lines) → X imported from
 * its new module, the others left where they were.
 */
export function importRewrite(
  source: string,
  site: Pick<CallSite, "line">,
  move: PythonMove,
): LineEdit | null {
  const lines = source.split("\n");
  const first = lines[site.line - 1];
  if (first === undefined) return null;
  const head = /^(\s*)from\s+([\w.]+)\s+import\s+(.*)$/.exec(first);
  if (!head || head[2] !== moduleOf(move.from)) return null;
  const indent = head[1] ?? "";
  // The statement's end: a parenthesised list runs to its `)`, a backslash to the next line.
  let end = site.line;
  let body = head[3] ?? "";
  while ((body.includes("(") && !body.includes(")")) || /\\\s*$/.test(body)) {
    const next = lines[end];
    if (next === undefined) return null;
    body = `${body.replace(/\\\s*$/, "")}\n${next}`;
    end++;
  }
  const comment = /\s*#[^\n]*$/.exec(body.replace(/^[\s\S]*\)/, ""))?.[0] ?? "";
  const names = body
    .replace(/#[^\n]*/g, "")
    .replace(/[()\\]/g, "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.includes("*")) return null;
  const name = nameOf(move.from);
  const at = names.findIndex((n) => n === name || n.startsWith(`${name} as `));
  if (at < 0) return null;
  const moved = names[at] as string;
  const rest = names.filter((_, i) => i !== at);
  const statement = `${indent}from ${moduleOf(move.to)} import ${nameOf(move.to)}${moved.includes(" as ") ? moved.slice(moved.indexOf(" as ")) : nameOf(move.to) !== name ? ` as ${name}` : ""}`;
  const before = lines.slice(site.line - 1, end).join("\n");
  const after = rest.length
    ? `${indent}from ${head[2]} import ${rest.join(", ")}${comment}\n${statement}`
    : `${statement}${comment}`;
  return { line: site.line, ...(end > site.line ? { endLine: end } : {}), before, after };
}

/**
 * The call at a site with one keyword argument taken out, with the comma that separated it; the
 * call may span lines. Null when the call doesn't pass that keyword at its top level.
 */
export function keywordRemoval(
  source: string,
  site: Pick<CallSite, "line" | "column">,
  arg: string,
): LineEdit | null {
  const lines = source.split("\n");
  const offset = lines.slice(0, site.line - 1).reduce((n, l) => n + l.length + 1, 0) + site.column - 1;
  // From the called name to its `(`: the name, then optional spaces.
  const name = /^[A-Za-z_]\w*\s*/.exec(source.slice(offset));
  if (!name) return null;
  const open = offset + name[0].length;
  if (source[open] !== "(") return null;
  const parts = topLevelArguments(source, open);
  if (!parts) return null;
  const { segments, close } = parts;
  const at = segments.findIndex((s) =>
    new RegExp(`^\\s*${arg}\\s*=(?!=)`).test(source.slice(s.start, s.end)),
  );
  if (at < 0) return null;
  const seg = segments[at] as { start: number; end: number };
  const next = segments[at + 1];
  const text = source.slice(seg.start, seg.end);
  const argStart = seg.start + (text.length - text.trimStart().length);
  const argEnd = seg.start + text.trimEnd().length;
  const lineStart = source.lastIndexOf("\n", argStart - 1) + 1;
  const afterComma = source[argEnd] === "," ? argEnd + 1 : argEnd;
  const restOfLine = /^[ \t]*(?:#[^\n]*)?\n/.exec(source.slice(afterComma));
  // On a line of its own, the whole line goes (its comma and comment with it); otherwise, with an
  // argument after it, it goes with its comma; as the last, with the comma before (a trailing comma
  // stays); alone, everything up to the `)`.
  const [from, to] =
    !source.slice(lineStart, argStart).trim() && restOfLine && lineStart > open
      ? [lineStart, afterComma + restOfLine[0].length]
      : next
        ? [seg.start, next.start]
        : at > 0
          ? [(segments[at - 1] as { end: number }).end, seg.end]
          : [seg.start, close];
  const edited = source.slice(0, from) + source.slice(to);
  const lastLine = source.slice(0, close).split("\n").length;
  const startOfLine = offset - (site.column - 1);
  const endOfLine = source.indexOf("\n", close);
  const before = source.slice(startOfLine, endOfLine < 0 ? source.length : endOfLine);
  const removed = to - from;
  const after = edited.slice(startOfLine, (endOfLine < 0 ? source.length : endOfLine) - removed);
  return { line: site.line, ...(lastLine > site.line ? { endLine: lastLine } : {}), before, after };
}

/**
 * A call's top-level arguments from its `(`: each segment between separators, a trailing comma
 * giving an empty last one (dropped). Strings, comments and nested brackets are skipped over.
 */
function topLevelArguments(source: string, open: number) {
  const segments: { start: number; end: number }[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < source.length; i++) {
    const c = source[i] as string;
    if (c === "#") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < source.length && !source.startsWith(quote, j)) j += source[j] === "\\" ? 2 : 1;
      i = j + quote.length - 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
    else if (c === ")" && depth === 0) {
      if (source.slice(start, i).trim()) segments.push({ start, end: i });
      return { segments, close: i };
    } else if (c === "," && depth === 0) {
      segments.push({ start, end: i });
      start = i + 1;
    }
  }
  return null;
}
