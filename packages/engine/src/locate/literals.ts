import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire as moduleRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { LITERALS } from "../constants";
import type { RepoTree } from "../inventory/tree";

/**
 * String literals that name a model or an API host (plan S04, research cross-cutting.md §6): ast-grep
 * nominates exact catalog model IDs and `http(s)://` literals in the string nodes of every language
 * Teire reads (JS/TS, Python, Go, Rust, Ruby, Java, Kotlin); config files (.env, YAML, TOML, JSON)
 * are searched for the same IDs as whole tokens. The text before a literal on its line says what it
 * is: an LLM call's model argument (`model: "…"`, `model="…"`, `.model("…")`, `openai("…")`), a
 * model-named variable or env default (`CHAT_MODEL ?? "…"`), a config value under a model key, or
 * something else (a label, a log line), which never opens a PR on its own.
 */
export type LiteralContext = "llm-call-arg" | "model-variable" | "config" | "other";

export interface LiteralHit {
  file: string;
  /** 1-based. */
  line: number;
  /** 0-based column of the literal's first character (inside the quotes). */
  column: number;
  value: string;
  kind: "model" | "url";
  lang: string;
  context: LiteralContext;
  snippet: string;
  /** For URLs: host and path, for matching HTTP operations. */
  host?: string;
  path?: string;
}

export interface LiteralScan {
  hits: LiteralHit[];
  filesScanned: number;
  languages: string[];
  ms: number;
}

const execFileAsync = promisify(execFile);

/** Grammar → the node holding a string's text, per ast-grep 0.50 (verified on all seven). */
const STRING_NODES: [language: string, kind: string, lang: string][] = [
  ["TypeScript", "string_fragment", "ts"],
  ["Tsx", "string_fragment", "ts"],
  ["JavaScript", "string_fragment", "js"],
  ["Python", "string_content", "py"],
  ["Go", "interpreted_string_literal_content", "go"],
  ["Go", "raw_string_literal_content", "go"],
  ["Rust", "string_content", "rust"],
  ["Ruby", "string_content", "ruby"],
  ["Java", "string_fragment", "jvm"],
  ["Kotlin", "string_content", "jvm"],
];

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|kts)$/;
const LANG_BY_EXT: [RegExp, string][] = [
  [/\.[cm]?tsx?$/, "ts"],
  [/\.[cm]?jsx?$/, "js"],
  [/\.py$/, "py"],
  [/\.go$/, "go"],
  [/\.rs$/, "rust"],
  [/\.rb$/, "ruby"],
  [/\.(?:java|kts?)$/, "jvm"],
];
const CONFIG_FILE = /(?:^|\/)(?:\.env(?:\.[\w-]+)?|[^/]+\.(?:ya?ml|toml|json|ini|cfg|properties))$/;
const SKIP_DIR =
  /(?:^|\/)(?:node_modules|vendor|dist|build|target|\.venv|venv|__pycache__|\.git|coverage|\.next|\.turbo)\//;

/** The ast-grep binary: `TEIRE_AST_GREP`, the platform package installed with the engine, or PATH. */
export function astGrepBinary() {
  if (process.env.TEIRE_AST_GREP) return process.env.TEIRE_AST_GREP;
  const require = moduleRequire(import.meta.url);
  const platform = `${process.platform}-${process.arch}${process.platform === "linux" ? "-gnu" : ""}`;
  try {
    return join(dirname(require.resolve(`@ast-grep/cli-${platform}/package.json`)), "ast-grep");
  } catch {
    return "ast-grep";
  }
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A definition named after the model: `def default_model`, `func DefaultModel()`, `String modelName() {`. */
const MODEL_DEFINITION =
  /\b(?:def|func|fn|function|fun)\s+(?:\([^)]*\)\s*)?(?:self\.)?\w*model\w*|\b\w*model\w*\s*\([^)]*\)\s*(?::\s*[\w<>?.]+\s*)?(?:->\s*[\w<>&'.]+\s*)?\{?\s*$|\b(?:get|val|var|let|const)\s+\w*model\w*\b[^=]*$/i;

/**
 * What the text before a source literal (up to its opening quote) says about it. `preceding` holds
 * the lines just above it: a literal alone on its line, or returned, is the value of the definition
 * it sits in, so `def default_model\n  "claude-…"\n end` names a model (live walk, teire-dev/bristow,
 * where the swap otherwise changed the spec and left the code).
 */
export function sourceContext(before: string, preceding: string[] = []): LiteralContext {
  const prefix = before.replace(/["'`]$/, "").trimEnd();
  // On the same line: `def default_model; "…"`, `def model() -> str: return "…"`.
  if (/\b(?:def|func|fn|function|fun)\s+\w*model\w*\b[^"'`]*$/i.test(prefix) && !/=$/.test(prefix))
    return "model-variable";
  // Alone on its line, or returned: the definition above decides.
  if (/^(?:return|=>|->)?\s*$/.test(prefix.trim())) {
    const above = preceding
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3);
    if (above.some((l) => MODEL_DEFINITION.test(l))) return "model-variable";
  }
  // `model: "…"`, `model="…"`, `"model": "…"`, `Model: "…"` (Go), `model => "…"`, `:model => "…"` (Ruby)
  if (/(?:^|[\s{(,:."'])model(?:_?(?:name|id))?["'`]?\s*(?::|=>|=)$/i.test(prefix)) return "llm-call-arg";
  // builders and provider factories: `.model("…")`, `openai("…")`, `GenerativeModel("…")`
  if (/\.(?:model|modelName|model_name|withModel|with_model)\s*\($/i.test(prefix)) return "llm-call-arg";
  if (
    // AI SDK providers may also name the API: `openai.chat("…")`, `google.languageModel("…")`.
    /\b(?:openai|anthropic|google|gemini|createOpenAI|ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI|GenerativeModel|getGenerativeModel|init_chat_model)(?:\.(?:chat|responses|completion|languageModel|textEmbeddingModel|embedding))?\s*\($/.test(
      prefix,
    )
  )
    return "llm-call-arg";
  // a model-named variable, constant or env default: `CHAT_MODEL = os.getenv("CHAT_MODEL", "…")`,
  // Rust's `env::var("MODEL").unwrap_or_else(|_| "…"`, Java's `Optional….orElse("…"`
  if (
    /\b\w*model\w*\b[^=]*?(?::?=|=>)\s*(?:.*?(?:\?\?|\|\||\bor\b|,|\bunwrap_or(?:_else)?\(\s*(?:\|[^|]*\|)?|\.orElse(?:Get)?\(\s*(?:\(\)\s*->)?)\s*)?$/i.test(
      prefix,
    )
  )
    return "model-variable";
  return "other";
}

/** Up to `count` lines above a 0-based line, read once per file. */
const fileLines = new Map<string, string[]>();
function linesAbove(repoDir: string, file: string, line: number, count: number) {
  const key = join(repoDir, file);
  let lines = fileLines.get(key);
  if (!lines) {
    try {
      lines = readFileSync(key, "utf8").split("\n");
    } catch {
      lines = [];
    }
    if (fileLines.size > 2_000) fileLines.clear();
    fileLines.set(key, lines);
  }
  return lines.slice(Math.max(0, line - count), line);
}

/** A config line holding an ID: under a model-named key (`model: …`, `CHAT_MODEL=…`) or not. */
function configContext(line: string, column: number): LiteralContext {
  return /model\w*["']?\s*[:=]/i.test(line.slice(0, column)) ? "config" : "other";
}

function urlParts(value: string) {
  try {
    const url = new URL(value);
    return { host: url.hostname, path: url.pathname };
  } catch {
    return {};
  }
}

interface AstGrepMatch {
  file: string;
  text: string;
  lines: string;
  language: string;
  ruleId: string;
  range: { start: { line: number; column: number } };
}

export async function locateLiterals(input: {
  repoDir: string;
  tree: RepoTree;
  /** Exact model IDs to look for (every catalog model ID, or the ones a change names). */
  modelIds: ReadonlySet<string>;
}): Promise<LiteralScan> {
  fileLines.clear();
  const started = Date.now();
  const ids = [...input.modelIds].filter(Boolean).sort((a, b) => b.length - a.length);
  const pattern = `${ids.length ? `^(?:${ids.map(escapeRegex).join("|")})$|` : ""}^https?://`;
  const rules = STRING_NODES.map(
    ([language, kind], i) =>
      `id: lit-${i}\nlanguage: ${language}\nrule:\n  kind: ${kind}\n  regex: '${pattern.replace(/'/g, "''")}'\n`,
  ).join("---\n");
  const scratch = await mkdtemp(join(tmpdir(), "teire-literals-"));
  const hits: LiteralHit[] = [];
  const languages = new Set<string>();
  try {
    const ruleFile = join(scratch, "rules.yml");
    await writeFile(ruleFile, rules);
    const globs = [
      "node_modules",
      "vendor",
      "dist",
      "build",
      "target",
      ".venv",
      "venv",
      "__pycache__",
      "coverage",
    ].flatMap((d) => ["--globs", `!**/${d}/**`]);
    const { stdout } = await execFileAsync(
      astGrepBinary(),
      ["scan", "--rule", ruleFile, "--json=stream", ...globs, "."],
      {
        cwd: input.repoDir,
        maxBuffer: LITERALS.maxOutputBytes,
        timeout: LITERALS.timeoutMs,
      },
    );
    for (const raw of stdout.split("\n")) {
      if (!raw.trim()) continue;
      const m = JSON.parse(raw) as AstGrepMatch;
      if (SKIP_DIR.test(m.file)) continue;
      const lang = STRING_NODES[Number(m.ruleId.slice(4))]?.[2] ?? m.language.toLowerCase();
      const kind = /^https?:\/\//.test(m.text) ? "url" : "model";
      const lineText = m.lines.split("\n")[0] ?? "";
      const preceding = kind === "model" ? linesAbove(input.repoDir, m.file, m.range.start.line, 4) : [];
      languages.add(lang);
      hits.push({
        file: m.file,
        line: m.range.start.line + 1,
        column: m.range.start.column,
        value: m.text,
        kind,
        lang,
        context: kind === "url" ? "other" : sourceContext(lineText.slice(0, m.range.start.column), preceding),
        snippet: lineText.trim().slice(0, 200),
        ...(kind === "url" ? urlParts(m.text) : {}),
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  // Config files: whole-token matches of the same IDs.
  const files = input.tree.files().filter((f) => !SKIP_DIR.test(`${f}`));
  if (ids.length) {
    const token = new RegExp(`(?<![\\w./-])(?:${ids.map(escapeRegex).join("|")})(?![\\w./-])`, "g");
    for (const file of files.filter((f) => CONFIG_FILE.test(f))) {
      let text: string;
      try {
        text = readFileSync(join(input.repoDir, file), "utf8");
      } catch {
        continue;
      }
      if (text.length > LITERALS.maxConfigBytes) continue;
      text.split("\n").forEach((line, i) => {
        for (const match of line.matchAll(token)) {
          languages.add("config");
          hits.push({
            file,
            line: i + 1,
            column: match.index ?? 0,
            value: match[0],
            kind: "model",
            lang: "config",
            context: configContext(line, match.index ?? 0),
            snippet: line.trim().slice(0, 200),
          });
        }
      });
    }
  }
  // Config embedded in source: a default config written from a template (a Go raw string of TOML, a
  // Python triple-quoted YAML) names the ID under a model key without it being a literal of its own.
  if (ids.length) {
    const keyed = new RegExp(
      `model\\w*["']?\\s*[:=]\\s*["']?((?:${ids.map(escapeRegex).join("|")}))(?![\\w./-])`,
      "gi",
    );
    const seen = new Set(hits.map((h) => `${h.file}:${h.line}:${h.value}`));
    for (const file of files.filter((f) => SOURCE_EXT.test(f))) {
      let text: string;
      try {
        text = readFileSync(join(input.repoDir, file), "utf8");
      } catch {
        continue;
      }
      if (text.length > LITERALS.maxConfigBytes) continue;
      const lang = LANG_BY_EXT.find(([re]) => re.test(file))?.[1] ?? "source";
      text.split("\n").forEach((line, i) => {
        for (const match of line.matchAll(keyed)) {
          const value = match[1] ?? "";
          // The key is matched in any case (`MODEL=`, `Model:`); the ID only exactly.
          if (!input.modelIds.has(value) || seen.has(`${file}:${i + 1}:${value}`)) continue;
          seen.add(`${file}:${i + 1}:${value}`);
          languages.add(lang);
          hits.push({
            file,
            line: i + 1,
            column: (match.index ?? 0) + match[0].length - value.length,
            value,
            kind: "model",
            lang,
            context: "config",
            snippet: line.trim().slice(0, 200),
          });
        }
      });
    }
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return {
    hits,
    filesScanned: files.filter((f) => SOURCE_EXT.test(f) || CONFIG_FILE.test(f)).length,
    languages: [...languages].sort(),
    ms: Date.now() - started,
  };
}
