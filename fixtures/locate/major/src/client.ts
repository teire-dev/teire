import { Agent } from "node:https";
import OpenAI from "openai";

/** A fetch-compatible function, injected in tests so they never touch the network. */
export type FetchLike = (url: string, init?: { method?: string; body?: unknown }) => Promise<Response>;

/** One shared client with keep-alive connections. */
export function createClient(apiKey: string, fetchImpl?: FetchLike): OpenAI {
  return new OpenAI({
    apiKey,
    maxRetries: 0,
    httpAgent: new Agent({ keepAlive: true }),
    // The SDK's own fetch type differs between versions; any fetch-compatible function works.
    ...(fetchImpl ? { fetch: fetchImpl as never } : {}),
  });
}
