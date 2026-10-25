import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoTree } from "../inventory/tree";

/**
 * Clients whose base URL the deployment sets (card C3: `*_BASE_URL` → inconclusive): `new OpenAI({
 * baseURL: process.env.OPENAI_BASE_URL })`, `Anthropic(base_url=os.environ["ANTHROPIC_BASE_URL"])`.
 * Such a client may talk to a gateway or another provider entirely, so whether a retired model ID
 * still breaks it depends on configuration Teire cannot see. Read in every language Teire scans.
 */
export interface BaseUrlOverride {
  file: string;
  line: number;
  /** The environment variable that sets the base URL. */
  envVar: string;
  snippet: string;
}

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|kts)$/;
const SKIP =
  /(?:^|\/)(?:node_modules|vendor|dist|build|target|\.venv|venv|__pycache__|\.git|tests?|__tests__)\//;
const BASE_KEY = /\b(?:base_?url|baseURL|BaseURL|api_?base|apiBase|base_uri|endpoint)\b/i;
/** process.env.X, process.env["X"], os.environ["X"], os.environ.get("X"), os.getenv("X"), ENV["X"], ENV.fetch("X"), System.getenv("X"), os.Getenv("X"), env::var("X"). */
const ENV_READ =
  /(?:process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[["']([A-Z][A-Z0-9_]*)["']\]|os\.environ(?:\.get)?[[(]["']([A-Z][A-Z0-9_]*)["']|os\.getenv\(["']([A-Z][A-Z0-9_]*)["']|ENV(?:\.fetch\(|\[)["']([A-Z][A-Z0-9_]*)["']|System\.getenv\("([A-Z][A-Z0-9_]*)"|os\.Getenv\("([A-Z][A-Z0-9_]*)"|env::var\("([A-Z][A-Z0-9_]*)")/g;
const URL_VAR = /(?:BASE_URL|BASE_URI|API_BASE|BASE|ENDPOINT|_URL|_HOST)$/;

export function findBaseUrlOverrides(repoDir: string, tree: RepoTree): BaseUrlOverride[] {
  const out: BaseUrlOverride[] = [];
  for (const file of tree.files()) {
    if (!SOURCE.test(file) || SKIP.test(file)) continue;
    let text: string;
    try {
      text = readFileSync(join(repoDir, file), "utf8");
    } catch {
      continue;
    }
    if (!BASE_KEY.test(text)) continue;
    text.split("\n").forEach((line, i) => {
      if (!BASE_KEY.test(line)) return;
      for (const m of line.matchAll(ENV_READ)) {
        const envVar = m.slice(1).find(Boolean);
        if (envVar && URL_VAR.test(envVar))
          out.push({ file, line: i + 1, envVar, snippet: line.trim().slice(0, 200) });
      }
    });
  }
  return out;
}
