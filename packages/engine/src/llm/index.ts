import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModelUsage } from "ai";
import { MODEL_ENV, NEMOTRON, TOKENFACTORY } from "../constants";

/** Which job a model does. Each maps to an env var so IDs are never hard-coded in logic. */
export type ModelRole = keyof typeof MODEL_ENV;

export interface TokenFactoryConfig {
  apiKey: string;
  baseURL?: string;
  models: Record<ModelRole, string>;
}

export function tokenFactoryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TokenFactoryConfig {
  const apiKey = env.TOKENFACTORY_API_KEY;
  if (!apiKey) throw new Error("TOKENFACTORY_API_KEY is not set");
  const models = Object.fromEntries(
    (Object.keys(MODEL_ENV) as ModelRole[]).map((role) => {
      const id = env[MODEL_ENV[role]];
      if (!id) throw new Error(`${MODEL_ENV[role]} is not set`);
      return [role, id];
    }),
  ) as Record<ModelRole, string>;
  return { apiKey, baseURL: env.TOKENFACTORY_BASE_URL || TOKENFACTORY.defaultBaseUrl, models };
}

export function createTokenFactory(config: TokenFactoryConfig) {
  const provider = createOpenAICompatible({
    name: TOKENFACTORY.providerName,
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? TOKENFACTORY.defaultBaseUrl,
    includeUsage: true,
  });
  return {
    config,
    model: (role: ModelRole) => provider(config.models[role]),
    modelId: (role: ModelRole) => config.models[role],
  };
}

export type TokenFactory = ReturnType<typeof createTokenFactory>;

interface NemotronFlags {
  /** Reasoning on (model default) or off. Off for extraction and triage. */
  thinking: boolean;
  /** Nemotron 3 Super only: cheaper reasoning for planning and routine steps. */
  lowEffort?: boolean;
  /** NVIDIA's model card: add force_nonempty_content for coding agents. */
  coding?: boolean;
}

/**
 * Nemotron chat-template flags sent in the request body. The AI SDK merges
 * `providerOptions.tokenfactory` keys into the body (ai-sdk.dev openai-compatible docs).
 */
export function nemotronOptions({ thinking, lowEffort, coding }: NemotronFlags) {
  const chatTemplateKwargs: Record<string, boolean> = { enable_thinking: thinking };
  if (thinking && lowEffort) chatTemplateKwargs.low_effort = true;
  if (coding) chatTemplateKwargs.force_nonempty_content = true;
  return { [TOKENFACTORY.providerName]: { chat_template_kwargs: chatTemplateKwargs } };
}

export const nemotronSampling = { temperature: NEMOTRON.temperature, topP: NEMOTRON.topP } as const;

/** Prices in USD per 1M tokens, read from Token Factory's public catalog. */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

const CATALOG_URL = "https://tokenfactory.nebius.com/api/public/models_info";

interface CatalogFlavor {
  model_id: string;
  input_price_per_million_tokens?: number;
  input_cached_price_per_million_tokens?: number;
  output_price_per_million_tokens?: number;
}

export async function fetchModelPrices(fetchImpl: typeof fetch = fetch): Promise<Map<string, ModelPrice>> {
  const res = await fetchImpl(CATALOG_URL);
  if (!res.ok) throw new Error(`Token Factory catalog returned ${res.status}`);
  const models = (await res.json()) as Array<{ flavors?: CatalogFlavor[] }>;
  const prices = new Map<string, ModelPrice>();
  for (const model of models) {
    for (const f of model.flavors ?? []) {
      if (f.input_price_per_million_tokens === undefined || f.output_price_per_million_tokens === undefined)
        continue;
      prices.set(f.model_id, {
        input: f.input_price_per_million_tokens,
        cachedInput: f.input_cached_price_per_million_tokens ?? f.input_price_per_million_tokens,
        output: f.output_price_per_million_tokens,
      });
    }
  }
  return prices;
}

export interface UsageReceipt {
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  costUsd: number;
}

export function receiptFor(usage: LanguageModelUsage, price: ModelPrice | undefined): UsageReceipt {
  const tokensIn = usage.inputTokens ?? 0;
  const tokensCached = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const tokensOut = usage.outputTokens ?? 0;
  const costUsd = price
    ? ((tokensIn - tokensCached) * price.input +
        tokensCached * price.cachedInput +
        tokensOut * price.output) /
      1_000_000
    : 0;
  return { tokensIn, tokensCached, tokensOut, costUsd };
}

/** One short real call, used by /health and the smoke checks. */
export async function ping(tf: TokenFactory, role: ModelRole, prices?: Map<string, ModelPrice>) {
  const started = Date.now();
  const result = await generateText({
    model: tf.model(role),
    prompt: "Reply with the single word: ready",
    maxOutputTokens: 16,
    ...nemotronSampling,
    providerOptions: nemotronOptions({ thinking: false }),
  });
  return {
    model: tf.modelId(role),
    text: result.text.trim(),
    latencyMs: Date.now() - started,
    ...receiptFor(result.usage, prices?.get(tf.modelId(role))),
  };
}
