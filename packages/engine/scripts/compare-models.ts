/**
 * Head-to-head of the Nemotron models on Teire's two real jobs, so model choice rests on results:
 *   1. fix: an agent edits a small repo for a real OpenAI retirement (gpt-4 → gpt-5.6-sol, shut down
 *      2026-10-23) where the model ID sits behind a config wrapper, next to decoys it must not touch;
 *   2. extract: turn a real deprecations table (OpenAI, 2026-04-22 section) into typed records.
 * Run: pnpm --filter @teire/engine exec tsx --env-file=../../.env.local scripts/compare-models.ts <src>
 * where <src> is a local copy of developers.openai.com/api/docs/deprecations.md.
 */
import { readFileSync } from "node:fs";
import { generateText, isStepCount, Output, tool } from "ai";
import { z } from "zod";
import {
  fetchModelPrices,
  nemotronOptions,
  nemotronSampling,
  receiptFor,
  tokenFactoryConfigFromEnv,
} from "../src/llm";

const MODELS = {
  ultra: "nvidia/Nemotron-3-Ultra-550b-a55b",
  super: "nvidia/nemotron-3-super-120b-a12b",
  lightning: "nvidia/Nemotron-3_5-Lightning",
};
const FIX_RUNS = process.env.JOBS === "extract" ? 0 : 3;
const EXTRACT_RUNS = process.env.THINK === "1" ? 3 : 2;

const config = tokenFactoryConfigFromEnv();
const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
const provider = createOpenAICompatible({
  name: "tokenfactory",
  apiKey: config.apiKey,
  baseURL: config.baseURL ?? "",
  includeUsage: true,
  supportsStructuredOutputs: true,
});
const prices = await fetchModelPrices();

const REPO: Record<string, string> = {
  "src/config.ts": [
    "export const MODELS = {",
    '  chat: process.env.CHAT_MODEL ?? "gpt-4",',
    '  summarize: "gpt-4o-mini-2024-07-18",',
    "};",
    "",
  ].join("\n"),
  "src/llm.ts": [
    'import OpenAI from "openai";',
    'import { MODELS } from "./config";',
    "const client = new OpenAI();",
    "export async function chat(messages: OpenAI.ChatCompletionMessageParam[]) {",
    "  const res = await client.chat.completions.create({ model: MODELS.chat, max_tokens: 400, messages });",
    '  return res.choices[0]?.message.content ?? "";',
    "}",
    "",
  ].join("\n"),
  "test/fixtures/recorded-response.json": '{ "id": "chatcmpl-1", "model": "gpt-4", "choices": [] }\n',
  "docs/HISTORY.md": "# History\n\n2024: launched on gpt-4.\n",
};

function scoreFix(files: Record<string, string>) {
  const cfg = files["src/config.ts"] ?? "";
  return {
    configUpdated: /chat:\s*process\.env\.CHAT_MODEL \?\? "gpt-5\.6-sol"/.test(cfg),
    otherModelUntouched: cfg.includes('"gpt-4o-mini-2024-07-18"'),
    fixtureUntouched:
      files["test/fixtures/recorded-response.json"] === REPO["test/fixtures/recorded-response.json"],
    historyUntouched: files["docs/HISTORY.md"] === REPO["docs/HISTORY.md"],
    noGpt4Left: !/"gpt-4"/.test(cfg) && !/"gpt-4"/.test(files["src/llm.ts"] ?? ""),
  };
}

async function fixRun(modelId: string) {
  const files = { ...REPO };
  const started = Date.now();
  const result = await generateText({
    model: provider(modelId),
    ...nemotronSampling,
    providerOptions: nemotronOptions({ thinking: true, coding: true }),
    stopWhen: isStepCount(16),
    system:
      "You are Teire's fix agent. You change only what the provider change requires, keep behaviour otherwise identical, never edit recorded test fixtures or historical docs, and call finish when done.",
    tools: {
      list_files: tool({
        description: "List repository files",
        inputSchema: z.object({}),
        execute: async () => Object.keys(files).join("\n"),
      }),
      read_file: tool({
        description: "Read a repository file",
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }) => files[path] ?? "not found",
      }),
      search_code: tool({
        description: "Search all files for a fixed string; returns path:line: text",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) =>
          Object.entries(files)
            .flatMap(([p, t]) =>
              t.split("\n").flatMap((line, i) => (line.includes(query) ? [`${p}:${i + 1}: ${line}`] : [])),
            )
            .join("\n") || "no matches",
      }),
      edit_file: tool({
        description: "Replace an exact substring in a file (must match once)",
        inputSchema: z.object({ path: z.string(), old: z.string(), new: z.string() }),
        execute: async ({ path, old, new: next }) => {
          const text = files[path];
          if (text === undefined) return "not found";
          if (text.split(old).length !== 2) return "old text must match exactly once";
          files[path] = text.replace(old, next);
          return "ok";
        },
      }),
      finish: tool({
        description: "Report the change made",
        inputSchema: z.object({ summary: z.string() }),
        execute: async () => "done",
      }),
    },
    prompt: [
      "Provider change (OpenAI deprecations page, 2026-04-22 announcement):",
      "| October 23, 2026 | `gpt-4-0613` \\| `gpt-4`, `gpt-4-0613-completions`, `gpt-4-completions` | `gpt-5.6-sol` |",
      "Finding: src/llm.ts:5 calls client.chat.completions.create with model MODELS.chat.",
      "Make the repository stop using the shut-down model.",
    ].join("\n"),
  });
  const receipt = receiptFor(result.totalUsage, prices.get(modelId));
  const score = scoreFix(files);
  return {
    pass: Object.values(score).every(Boolean),
    score,
    steps: result.steps.length,
    ms: Date.now() - started,
    ...receipt,
  };
}

/** Expected rows straight from the table: every backticked ID maps to the row's replacement. */
function expectedRows(section: string) {
  const out = new Map<string, string>();
  for (const line of section.split("\n")) {
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    if (cells.length < 4 || !/\d{4}/.test(cells[1] ?? "")) continue;
    const ids = [...(cells[2] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
    const replacement = (cells[3] ?? "").match(/`([^`]+)`/)?.[1] ?? "";
    for (const id of ids) out.set(id, replacement);
  }
  return out;
}

async function extractRun(modelId: string, section: string, expected: Map<string, string>) {
  const started = Date.now();
  const result = await generateText({
    model: provider(modelId),
    ...nemotronSampling,
    providerOptions: nemotronOptions({ thinking: process.env.THINK === "1" }),
    output: Output.object({
      schema: z.object({
        records: z.array(
          z.object({
            modelId: z.string(),
            shutdownDate: z.string().describe("YYYY-MM-DD"),
            replacement: z.string(),
            quote: z.string().describe("the exact table row this came from"),
          }),
        ),
      }),
    }),
    prompt: `Extract one record per model ID (every backticked ID, aliases included) from this provider deprecation notice. Use only what the text says.\n\n${section}`,
  });
  const got = new Map(result.output.records.map((r) => [r.modelId, r.replacement]));
  let correct = 0;
  for (const [id, rep] of expected) if (got.get(id)?.startsWith(rep)) correct++;
  const extra = [...got.keys()].filter((id) => !expected.has(id)).length;
  const quotesVerbatim = result.output.records.filter((r) => section.includes(r.quote.trim())).length;
  return {
    recall: `${correct}/${expected.size}`,
    extra,
    quotesVerbatim: `${quotesVerbatim}/${result.output.records.length}`,
    ms: Date.now() - started,
    ...receiptFor(result.usage, prices.get(modelId)),
  };
}

const source = readFileSync(process.argv[2] ?? "", "utf8");
const start = source.indexOf("### 2026-04-22: Legacy GPT model snapshots\n");
const section = source.slice(
  start,
  source.indexOf("### 2026-04-22: Legacy GPT model snapshots (July", start),
);
const expected = expectedRows(section);

for (const [name, id] of Object.entries(MODELS)) {
  if (name !== "lightning") {
    for (let i = 0; i < FIX_RUNS; i++) {
      const r = await fixRun(id).catch((e: Error) => ({ error: e.message.slice(0, 200) }));
      console.log(JSON.stringify({ job: "fix", model: name, run: i + 1, ...r }));
    }
  }
  for (let i = 0; i < EXTRACT_RUNS; i++) {
    const r = await extractRun(id, section, expected).catch((e: Error) => ({
      error: e.message.slice(0, 200),
    }));
    console.log(JSON.stringify({ job: "extract", model: name, run: i + 1, ...r }));
  }
}
