import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CallSite, Ecosystem } from "../contract";
import { fetchSdkSource } from "../discover/sdk-sources";
import type { FindingDraft } from "../impact";
import type { CodemodEdit, MigrationNote } from "./codemods";

/**
 * Renames in every language (S15.4, R21.7): where a quoted migration note says an API was renamed,
 * the located sites are edited in place, the way JS's call-chain codemod edits its own. The plan's
 * "ast-grep" wording becomes the locator's ranges: each site is already resolved by type, import or
 * name, so the edit replaces the old name at that position only. An edit is kept only when the
 * target version's own source defines the new name and no longer defines the old one; anything
 * else is left to the agent, and the repository's checks verify every edit either way.
 */
export type RenameLanguage = "python" | "go" | "rust" | "ruby" | "java";

export const RENAME_LANGUAGE: Partial<Record<Ecosystem, RenameLanguage>> = {
  pypi: "python",
  go: "go",
  cargo: "rust",
  rubygems: "ruby",
  maven: "java",
};

const SYMBOL = String.raw`[A-Za-z_$][\w$]*(?:(?:::|\.|#)[A-Za-z_$][\w$]*)*`;
const lastName = (symbol: string) =>
  symbol
    .replace(/\(\)$/, "")
    .split(/::|\.|#/)
    .at(-1) ?? symbol;

/**
 * The old → new names a note states for one API: "`X` was renamed to `Y`", "renamed `X` to `Y`",
 * "`X` → `Y`", "use `Y` instead of `X`", or an `apis` entry with a single-symbol `replacement`.
 */
export function noteRenames(note: MigrationNote): [string, string][] {
  const out: [string, string][] = [];
  // The segment that differs: the last name (`thread_rng` → `rng`), or the one segment that changed
  // in an otherwise equal path (`Matchers.any` → `ArgumentMatchers.any`).
  const add = (from: string, to: string) => {
    const [x, y] = [from, to].map((v) => v.replace(/\(\)$/, "").split(/::|\.|#/));
    let pair: [string, string] | null = null;
    if (x && y && x.at(-1) !== y.at(-1)) pair = [lastName(from), lastName(to)];
    else if (x && y && x.length === y.length) {
      const differ = x.map((part, i) => (part !== y[i] ? i : -1)).filter((i) => i >= 0);
      if (differ.length === 1) pair = [x[differ[0] as number] as string, y[differ[0] as number] as string];
    }
    if (pair && !out.some(([a, b]) => a === pair[0] && b === pair[1])) out.push(pair);
  };

  const q = note.quote;
  const patterns: [RegExp, boolean][] = [
    [
      new RegExp(
        String.raw`\`(${SYMBOL})(?:\(\))?\`\s*(?:has been|was|is now|is)?\s*renamed\s+(?:to\s+)?\`(${SYMBOL})(?:\(\))?\``,
        "gi",
      ),
      false,
    ],
    [
      new RegExp(String.raw`renamed\s+\`(${SYMBOL})(?:\(\))?\`\s+(?:to|as)\s+\`(${SYMBOL})(?:\(\))?\``, "gi"),
      false,
    ],
    [new RegExp(String.raw`\`(${SYMBOL})(?:\(\))?\`\s*(?:→|->|=>)\s*\`(${SYMBOL})(?:\(\))?\``, "g"), false],
    [
      new RegExp(String.raw`use\s+\`(${SYMBOL})(?:\(\))?\`\s+instead\s+of\s+\`(${SYMBOL})(?:\(\))?\``, "gi"),
      true,
    ],
  ];
  for (const [re, swapped] of patterns)
    for (const m of q.matchAll(re)) if (m[1] && m[2]) swapped ? add(m[2], m[1]) : add(m[1], m[2]);
  if (note.replacement && new RegExp(`^${SYMBOL}(?:\\(\\))?$`).test(note.replacement.trim()))
    for (const api of note.apis) add(api, note.replacement.trim());
  return out;
}

const word = (n: string) => n.replace(/[$]/g, "\\$");

/** Whether the target's source defines `name`: as a declaration, or for a keyword, as a parameter. */
const DEFINES: Record<RenameLanguage, (n: string) => RegExp> = {
  python: (n) => new RegExp(String.raw`^\s*(?:async\s+)?def\s+${n}\b|^\s*class\s+${n}\b|^${n}\s*[:=]`, "m"),
  go: (n) =>
    new RegExp(
      String.raw`^func\s+(?:\([^)]*\)\s*)?${n}\b|^\s*(?:type|var|const)\s+${n}\b|^\s+${n}\s+(?:=|[\w*\[])`,
      "m",
    ),
  rust: (n) =>
    new RegExp(
      String.raw`\b(?:fn|struct|enum|trait|type|const|static|mod|union)\s+${n}\b|macro_rules!\s*${n}\b`,
    ),
  ruby: (n) =>
    new RegExp(
      String.raw`^\s*def\s+(?:self\.)?${n}\b|^\s*(?:class|module)\s+(?:\w+::)*${n}\b|alias(?:_method)?\s+:?${n}\b`,
      "m",
    ),
  java: (n) =>
    new RegExp(
      String.raw`\b(?:class|interface|enum|record|object|fun|val|var)\s+${n}\b|\b${n}\s*\([^;{}]*\)\s*(?:throws[^;{]*)?\{`,
    ),
};
const PARAMETER = (n: string) => new RegExp(String.raw`[(,]\s*\**${n}\s*[:=]|^\s+\**${n}\s*[:=]`, "m");

/** The target's definitions as a lookup; `asParameter` for keyword-argument renames. */
export function targetDefinitions(language: RenameLanguage, files: readonly { text: string }[]) {
  const text = files.map((f) => f.text).join("\n");
  const memo = new Map<string, boolean>();
  return (name: string, asParameter = false) => {
    const key = `${asParameter ? "p" : "d"}:${name}`;
    let hit = memo.get(key);
    if (hit === undefined) {
      hit = (asParameter ? PARAMETER(word(name)) : DEFINES[language](word(name))).test(text);
      memo.set(key, hit);
    }
    return hit;
  };
}

const RENAMABLE = new Set<CallSite["kind"]>(["call", "property", "import", "type-ref", "new"]);

/** The edits: one per site and pair, at the occurrence of the old name nearest the site's column. */
export function planRenames(input: {
  repoDir: string;
  sites: readonly CallSite[];
  notes: readonly MigrationNote[];
  defines: (name: string, asParameter?: boolean) => boolean;
  /** Sites of parameter changes: their renames are keywords, checked as parameters. */
  keywordSites?: ReadonlySet<CallSite>;
}): CodemodEdit[] {
  const edits: CodemodEdit[] = [];
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
    // A site found by its name alone may be another receiver's method of the same name: the agent
    // reads it in context instead.
    if (!RENAMABLE.has(site.kind) || site.resolution === "name-only") continue;
    const keyword = input.keywordSites?.has(site) ?? false;
    const text = fileLines(site.file)[site.line - 1];
    if (text === undefined || edits.some((e) => e.file === site.file && e.line === site.line)) continue;
    for (const note of input.notes)
      for (const [from, to] of noteRenames(note)) {
        if (input.defines(from, keyword) || !input.defines(to, keyword)) continue;
        const re = new RegExp(String.raw`(?<![\w$])${word(from)}(?![\w$])`, "g");
        const at = [...text.matchAll(re)].map((m) => m.index ?? 0);
        if (!at.length) continue;
        const pick = at.sort((a, b) => Math.abs(a + 1 - site.column) - Math.abs(b + 1 - site.column))[0] ?? 0;
        const after = `${text.slice(0, pick)}${to}${text.slice(pick + from.length)}`;
        edits.push({
          file: site.file,
          line: site.line,
          before: text,
          after,
          reason: `${from} → ${to}`,
          noteUrl: note.url,
        });
        break;
      }
  }
  return edits;
}

/** A Python wheel's own source files (the unpacked target), bounded like the other readers. */
function wheelSources(dir: string) {
  const out: { path: string; text: string }[] = [];
  let total = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        if (!entry.endsWith(".dist-info")) walk(full);
      } else if (/\.pyi?$/.test(entry) && s.size < 2 * 1024 * 1024 && total < 64 * 1024 * 1024) {
        total += s.size;
        out.push({ path: relative(dir, full), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * The renames for one package's run: the lead package's located sites (a moved package's sites
 * belong to its own source), the target version's source as the proof, the quoted notes as the
 * source of each name. Never throws: a source that can't be read means no deterministic rename.
 */
export async function plannedRenames(input: {
  ecosystem: Ecosystem;
  name: string;
  target: string;
  repoDir: string;
  findings: readonly FindingDraft[];
  notes: readonly MigrationNote[];
  /** PyPI: the unpacked target wheel. */
  targetDir?: string;
}): Promise<CodemodEdit[]> {
  const language = RENAME_LANGUAGE[input.ecosystem];
  if (!language || !input.notes.some((n) => noteRenames(n).length)) return [];
  const own = input.findings.filter((f) => !f.via);
  const sites = own.flatMap((f) => f.callSites);
  if (!sites.length) return [];
  try {
    const files =
      input.ecosystem === "pypi"
        ? input.targetDir
          ? wheelSources(input.targetDir)
          : []
        : ((
            await fetchSdkSource(
              input.ecosystem as "go" | "cargo" | "rubygems" | "maven",
              input.name,
              input.target,
            )
          )?.files ?? []);
    if (!files.length) return [];
    const keywordSites = new Set(
      own.filter((f) => f.changeKind === "parameter-change").flatMap((f) => f.callSites),
    );
    return planRenames({
      repoDir: input.repoDir,
      sites,
      notes: input.notes,
      defines: targetDefinitions(language, files),
      keywordSites,
    });
  } catch {
    return [];
  }
}
