/**
 * Token Factory smoke checks (plan S00). Run:
 *   pnpm --filter @teire/engine smoke
 * Prints one JSON result per check; never prints the API key.
 */
import { generateText, isStepCount, tool } from "ai";
import { z } from "zod";
import {
  createTokenFactory,
  fetchModelPrices,
  nemotronOptions,
  nemotronSampling,
  receiptFor,
  tokenFactoryConfigFromEnv,
} from "../src/llm";

const config = tokenFactoryConfigFromEnv();
const base = (config.baseURL ?? "").replace(/\/$/, "");
const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
const results: Record<string, unknown> = {};

function report(name: string, value: unknown) {
  results[name] = value;
  console.log(JSON.stringify({ check: name, ...((value as object) ?? {}) }));
}

interface ChatJson {
  choices?: Array<{
    message?: { content?: string; tool_calls?: Array<{ function: { arguments: string } }> };
  }>;
  error?: unknown;
  raw?: string;
}

async function chat(body: object, baseUrl = base) {
  const started = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: ChatJson;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return {
    status: res.status,
    ms: Date.now() - started,
    json,
    retryAfter: res.headers.get("retry-after"),
  };
}

const weatherTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file from the repository",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Repository-relative path" } },
      required: ["path"],
    },
  },
};

async function main() {
  // 1. Exact model IDs
  const modelsRes = await fetch(`${base}/models`, { headers });
  const models = (await modelsRes.json()) as { data?: Array<{ id: string; shutdown_date?: string }> };
  const nvidia = (models.data ?? []).filter((m) => m.id.toLowerCase().includes("nvidia")).map((m) => m.id);
  report("models", {
    status: modelsRes.status,
    total: models.data?.length ?? 0,
    nvidia,
    configured: config.models,
    configuredPresent: Object.fromEntries(
      Object.entries(config.models).map(([role, id]) => [role, nvidia.includes(id)]),
    ),
  });

  // 2. Tool calling reliability on the agent model (raw API, 10 runs)
  const driver = config.models.agent;
  let validCalls = 0;
  const latencies: number[] = [];
  for (let i = 0; i < 10; i++) {
    const r = await chat({
      model: driver,
      temperature: 1.0,
      top_p: 0.95,
      max_tokens: 800,
      tools: [weatherTool],
      tool_choice: "auto",
      chat_template_kwargs: { enable_thinking: true, low_effort: true, force_nonempty_content: true },
      messages: [
        { role: "user", content: "Open src/client.ts so you can find where the model is configured." },
      ],
    });
    latencies.push(r.ms);
    const call = r.json?.choices?.[0]?.message?.tool_calls?.[0];
    try {
      if (call && JSON.parse(call.function.arguments).path) validCalls++;
    } catch {}
  }
  latencies.sort((a, b) => a - b);
  report("tool_calling_driver", {
    model: driver,
    validCalls,
    of: 10,
    p50ms: latencies[4],
    p95ms: latencies[9],
  });

  // 3 + 4. AI SDK path: body carries chat_template_kwargs, multi-step tool loop finishes
  const seenBodies: string[] = [];
  const loggingFetch: typeof fetch = async (input, init) => {
    if (init?.body) seenBodies.push(String(init.body));
    return fetch(input, init);
  };
  const tf = createTokenFactory(config);
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const sdkProvider = createOpenAICompatible({
    name: "tokenfactory",
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? "",
    includeUsage: true,
    fetch: loggingFetch,
  });
  const files: Record<string, string> = {
    "src/client.ts": 'export const MODEL = "gpt-3.5-turbo";\n',
  };
  const loop = await generateText({
    model: sdkProvider(driver),
    ...nemotronSampling,
    providerOptions: nemotronOptions({ thinking: true, lowEffort: true, coding: true }),
    stopWhen: isStepCount(6),
    tools: {
      read_file: tool({
        description: "Read a file from the repository",
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }) => files[path] ?? "not found",
      }),
      edit_file: tool({
        description: "Replace the full contents of a file",
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ path, content }) => {
          files[path] = content;
          return "ok";
        },
      }),
    },
    prompt:
      "OpenAI shut down gpt-3.5-turbo; its replacement is gpt-5.6-terra. Read src/client.ts, update the model ID, then reply DONE.",
  });
  report("ai_sdk_loop", {
    chatTemplateKwargsOnWire: seenBodies.some((b) => b.includes("chat_template_kwargs")),
    steps: loop.steps.length,
    toolCalls: loop.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
    edited: files["src/client.ts"]?.includes("gpt-5.6-terra") ?? false,
    finalText: loop.text.slice(0, 80),
    usage: loop.totalUsage,
  });

  // 5. Thinking off on the reader model
  const fast = await generateText({
    model: tf.model("reader"),
    ...nemotronSampling,
    maxOutputTokens: 64,
    providerOptions: nemotronOptions({ thinking: false }),
    prompt:
      "Classify this changelog line as breaking or not, answer one word: 'Removed the temperature parameter.'",
  });
  report("thinking_off_fast", {
    model: tf.modelId("reader"),
    text: fast.text.trim().slice(0, 40),
    reasoningTokens: fast.usage.outputTokenDetails?.reasoningTokens ?? null,
    outputTokens: fast.usage.outputTokens,
  });

  // 6. Structured output: json_schema vs json_object
  const schemaRes = await chat({
    model: config.models.reader,
    max_tokens: 200,
    chat_template_kwargs: { enable_thinking: false },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "verdict",
        strict: true,
        schema: {
          type: "object",
          properties: { breaking: { type: "boolean" }, reason: { type: "string" } },
          required: ["breaking", "reason"],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: "user", content: "Is removing a required API parameter breaking? Answer in JSON." }],
  });
  const schemaContent = schemaRes.json?.choices?.[0]?.message?.content ?? "";
  let schemaValid = false;
  try {
    const parsed = JSON.parse(schemaContent);
    schemaValid = typeof parsed.breaking === "boolean" && typeof parsed.reason === "string";
  } catch {}
  report("json_schema", { status: schemaRes.status, schemaValid, sample: schemaContent.slice(0, 120) });

  // 7. Ultra on global and us-central1 base URLs
  for (const [label, url] of [
    ["global", base],
    ["us-central1", "https://api.tokenfactory.us-central1.nebius.com/v1"],
  ] as const) {
    const r = await chat(
      {
        model: config.models.agent,
        max_tokens: 16,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "user", content: "Reply with: ready" }],
      },
      url,
    );
    report(`ultra_${label}`, {
      status: r.status,
      ms: r.ms,
      text: r.json?.choices?.[0]?.message?.content?.slice(0, 20) ?? r.json?.error ?? r.json,
    });
  }

  // 8. Burst of 10 parallel driver calls
  const burst = await Promise.all(
    Array.from({ length: 10 }, () =>
      chat({
        model: driver,
        max_tokens: 8,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "user", content: "Reply with: ok" }],
      }),
    ),
  );
  report("burst_10", {
    statuses: burst.map((b) => b.status),
    retryAfter: burst.map((b) => b.retryAfter).filter(Boolean),
    errors: burst.filter((b) => b.status >= 400).map((b) => JSON.stringify(b.json).slice(0, 160)),
  });

  // 9. Cost of the loop at catalog prices
  const prices = await fetchModelPrices();
  report("loop_cost", { model: driver, ...receiptFor(loop.totalUsage, prices.get(driver)) });
}

main().catch((error) => {
  console.error(JSON.stringify({ check: "fatal", error: (error as Error).message }));
  process.exit(1);
});
