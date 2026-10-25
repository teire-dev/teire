import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { directoryTree } from "../src/inventory";
import { locateLiterals, sourceContext } from "../src/locate/literals";

const IDS = new Set([
  "gpt-4",
  "gpt-4-0613",
  "gpt-3.5-turbo-0125",
  "claude-3-haiku-20240307",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "meta-llama/Llama-3.3-70B-Instruct",
]);

describe("what the text before a literal says", () => {
  it("tells LLM arguments, model variables and everything else apart", () => {
    expect(sourceContext('client.messages.create(model: "')).toBe("llm-call-arg");
    expect(sourceContext('{ "model": "')).toBe("llm-call-arg");
    expect(sourceContext('Request{Model: "')).toBe("llm-call-arg");
    expect(sourceContext('builder().model("')).toBe("llm-call-arg");
    expect(sourceContext('generateText({ model: openai("')).toBe("llm-call-arg");
    expect(sourceContext('streamText({ messages, model: openai.chat("')).toBe("llm-call-arg");
    expect(sourceContext('const m = google.languageModel("')).toBe("llm-call-arg");
    expect(sourceContext('const CHAT_MODEL = process.env.CHAT_MODEL ?? "')).toBe("model-variable");
    expect(sourceContext('DEFAULT_MODEL_ID = os.environ.get("X", "')).toBe("model-variable");
    expect(sourceContext('export const label = "')).toBe("other");
    expect(sourceContext('fmt.Println(req, url, "')).toBe("other");
  });
});

// Runs the real ast-grep 0.50 binary installed with the engine.
describe("literal locator across languages", () => {
  it("finds exact catalog IDs and URLs in seven grammars and config files, never in dependencies", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "teire-literals-"));
    cpSync(resolve(import.meta.dirname, "../../../fixtures/literals"), repoDir, { recursive: true });
    mkdirSync(join(repoDir, "node_modules/openai"), { recursive: true });
    writeFileSync(join(repoDir, "node_modules/openai/index.js"), 'export const m = "gpt-4";\n');
    const scan = await locateLiterals({ repoDir, tree: directoryTree(repoDir), modelIds: IDS });
    const at = (file: string, line: number) => scan.hits.find((h) => h.file === file && h.line === line);
    expect(scan.languages).toEqual(["config", "go", "jvm", "py", "ruby", "rust", "ts"]);
    expect(at("src/chat.ts", 9)).toMatchObject({ value: "gpt-4-0613", context: "llm-call-arg", column: 59 });
    expect(at("src/chat.ts", 10)).toMatchObject({ value: "gpt-3.5-turbo-0125", context: "llm-call-arg" });
    expect(at("src/chat.ts", 6)).toMatchObject({ value: "gpt-4", context: "model-variable" });
    expect(at("src/chat.ts", 14)).toMatchObject({ value: "gpt-4", context: "other" });
    expect(at("src/chat.ts", 11)).toMatchObject({ kind: "url", host: "api.openai.com", path: "/v1/engines" });
    expect(at("app/agent.py", 10)).toMatchObject({
      value: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
      context: "llm-call-arg",
    });
    expect(at("app/agent.py", 5)).toMatchObject({ context: "model-variable" });
    expect(at("cmd/main.go", 8)).toMatchObject({ value: "gpt-4-0613", context: "llm-call-arg", lang: "go" });
    expect(at("cmd/main.go", 9)).toMatchObject({ kind: "url", host: "api.anthropic.com" });
    expect(at("lib/client.rb", 4)).toMatchObject({ context: "llm-call-arg", lang: "ruby" });
    expect(at("java/Chat.java", 3)).toMatchObject({ context: "llm-call-arg", lang: "jvm" });
    expect(at("kt/Chat.kt", 2)).toMatchObject({ context: "llm-call-arg", lang: "jvm" });
    expect(at("rs/main.rs", 2)).toMatchObject({ context: "llm-call-arg", lang: "rust" });
    expect(at("config/settings.yaml", 2)).toMatchObject({ value: "gpt-4-0613", context: "config" });
    expect(at(".env.example", 2)).toMatchObject({ value: "gpt-4", context: "config" });
    // Prose that merely mentions an ID is not a literal of it, and dependencies are not the repo's code.
    expect(scan.hits.some((h) => h.snippet.includes("is not a model here") && h.value === "gpt-4")).toBe(
      false,
    );
    expect(scan.hits.some((h) => h.file.startsWith("node_modules"))).toBe(false);
  }, 60_000);
});
