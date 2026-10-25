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

/** Token Factory answered 402: the account has no credits left. Runs stop until an operator tops up. */
export class CreditsExhaustedError extends Error {
  constructor(detail: string) {
    super(`Token Factory credits are exhausted (402): ${detail}`);
    this.name = "CreditsExhaustedError";
  }
}

/** Model health shared by every client in this process: model id → unhealthy until (ms). */
const unhealthyUntil = new Map<string, number>();

export function modelHealth() {
  const now = Date.now();
  return [...unhealthyUntil]
    .filter(([, until]) => until > now)
    .map(([model, until]) => ({ model, until: new Date(until) }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The client's fetch (plan S10): retries 429/5xx and dropped connections with backoff (honouring
 * Retry-After); turns a 402 credit error into `CreditsExhaustedError`; and when a model still fails
 * after its retries, marks it unhealthy for a while and sends that request, and the next ones, to
 * the failover model (Nemotron 3 Super), so a run continues instead of dying.
 */
export function tokenFactoryFetch(config: TokenFactoryConfig, base: typeof fetch = fetch): typeof fetch {
  const failover = config.models.failover;
  const withModel = (body: RequestInit["body"], model: string) => {
    if (typeof body !== "string") return body;
    try {
      return JSON.stringify({ ...JSON.parse(body), model });
    } catch {
      return body;
    }
  };
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    let body = init?.body;
    let model: string | undefined;
    if (typeof body === "string")
      try {
        model = (JSON.parse(body) as { model?: string }).model;
      } catch {
        model = undefined;
      }
    if (model && model !== failover && (unhealthyUntil.get(model) ?? 0) > Date.now()) {
      body = withModel(body, failover);
      model = failover;
    }
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await base(input, { ...init, body });
      } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        if (attempt < TOKENFACTORY.attempts) {
          await sleep(TOKENFACTORY.backoffMs * 2 ** (attempt - 1));
          continue;
        }
        throw error;
      }
      if (res.status === 402) {
        const text = await res.clone().text();
        if (/credit|balance|payment|insufficient/i.test(text))
          throw new CreditsExhaustedError(text.slice(0, 300));
        return res;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < TOKENFACTORY.attempts) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(
          after > 0
            ? Math.min(after * 1000, TOKENFACTORY.maxRetryAfterMs)
            : TOKENFACTORY.backoffMs * 2 ** (attempt - 1),
        );
        continue;
      }
      // Still failing (or the model is gone): the failover model takes this request and the next ones.
      if ((res.status >= 500 || res.status === 404) && model && failover && model !== failover) {
        unhealthyUntil.set(model, Date.now() + TOKENFACTORY.unhealthyForMs);
        return base(input, { ...init, body: withModel(body, failover) });
      }
      return res;
    }
  }) as typeof fetch;
}

export function createTokenFactory(config: TokenFactoryConfig, fetchImpl?: typeof fetch) {
  const provider = createOpenAICompatible({
    name: TOKENFACTORY.providerName,
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? TOKENFACTORY.defaultBaseUrl,
    includeUsage: true,
    // Token Factory accepts response_format json_schema (smoke check 6), so let the SDK send it.
    supportsStructuredOutputs: true,
    fetch: tokenFactoryFetch(config, fetchImpl),
  });
  // The model a request will actually use: the failover while the role's model is unhealthy.
  const active = (role: ModelRole) => {
    const id = config.models[role];
    return id !== config.models.failover && (unhealthyUntil.get(id) ?? 0) > Date.now()
      ? config.models.failover
      : id;
  };
  return {
    config,
    model: (role: ModelRole) => provider(config.models[role]),
    modelId: active,
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
