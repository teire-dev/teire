import { type ProviderRecord, providerRecord } from "./schema";

export type { ProviderRecord };

import anthropic from "../../../../catalog/providers/anthropic.json" with { type: "json" };
import googleGemini from "../../../../catalog/providers/google-gemini.json" with { type: "json" };
import nebiusTokenFactory from "../../../../catalog/providers/nebius-token-factory.json" with {
  type: "json",
};
import openai from "../../../../catalog/providers/openai.json" with { type: "json" };
import stripe from "../../../../catalog/providers/stripe.json" with { type: "json" };

/**
 * Curated providers whose change pages Teire can read directly (a table, a notices index), kept as
 * JSON in the repository's `catalog/providers/` (C13): anyone, a provider's own team included, can
 * add or correct one through a pull request, validated in CI. They are not a list Teire watches: a
 * provider's pages are read only when a scanned repo talks to it (its SDK is installed, or its API
 * host is in the code), D82.
 */
const definitions: unknown[] = [openai, anthropic, googleGemini, nebiusTokenFactory, stripe];

export const PROVIDERS: readonly ProviderRecord[] = definitions.map((p) => providerRecord.parse(p));

export function providerBySlug(slug: string) {
  return PROVIDERS.find((p) => p.slug === slug);
}
