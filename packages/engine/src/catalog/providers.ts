import { CATALOG_SCHEMA_VERSION, type ProviderRecord, providerRecord } from "./schema";

export type { ProviderRecord };

/**
 * Readers for providers whose change pages Teire can parse directly (a table, a notices index). They
 * are not a list Teire watches: a provider's pages are read only when a scanned repo talks to it
 * (its SDK is installed, or its API host is in the code), D82. Source URLs were fetched live (HTTP
 * 200, markdown) on 2026-10-24; SDK package names were checked on the npm and PyPI registries.
 */
const definitions: ProviderRecord[] = [
  {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    slug: "openai",
    name: "OpenAI",
    homepage: "https://developers.openai.com/api/docs",
    logo: { light: "/logos/openai-light.svg", dark: "/logos/openai-dark.svg" },
    officialDomains: ["developers.openai.com", "platform.openai.com", "openai.com"],
    sources: [
      {
        kind: "deprecations",
        url: "https://developers.openai.com/api/docs/deprecations.md",
        adapter: "openai-deprecations",
      },
    ],
    sdks: [
      { ecosystem: "npm", name: "openai" },
      { ecosystem: "npm", name: "@ai-sdk/openai" },
      { ecosystem: "npm", name: "@langchain/openai" },
      { ecosystem: "pypi", name: "openai" },
      { ecosystem: "pypi", name: "langchain-openai" },
    ],
    detection: {
      imports: ["openai", "@ai-sdk/openai", "@langchain/openai", "langchain_openai"],
      envVars: ["OPENAI_API_KEY"],
      baseUrls: ["api.openai.com"],
      calls: [
        "chat.completions.create",
        "chat.completions.parse",
        "chat.completions.stream",
        "beta.chat.completions.parse",
        "beta.chat.completions.stream",
        "responses.create",
        "responses.parse",
        "responses.stream",
        "completions.create",
        "embeddings.create",
      ],
    },
  },
  {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    slug: "anthropic",
    name: "Anthropic",
    homepage: "https://platform.claude.com/docs",
    logo: { light: "/logos/anthropic-light.svg", dark: "/logos/anthropic-dark.svg" },
    officialDomains: ["platform.claude.com", "docs.anthropic.com", "anthropic.com"],
    sources: [
      {
        kind: "deprecations",
        url: "https://platform.claude.com/docs/en/about-claude/model-deprecations.md",
        adapter: "anthropic-deprecations",
      },
    ],
    sdks: [
      { ecosystem: "npm", name: "@anthropic-ai/sdk" },
      { ecosystem: "npm", name: "@ai-sdk/anthropic" },
      { ecosystem: "npm", name: "@langchain/anthropic" },
      { ecosystem: "pypi", name: "anthropic" },
      { ecosystem: "pypi", name: "langchain-anthropic" },
    ],
    detection: {
      imports: [
        "@anthropic-ai/sdk",
        "@ai-sdk/anthropic",
        "@langchain/anthropic",
        "anthropic",
        "langchain_anthropic",
      ],
      envVars: ["ANTHROPIC_API_KEY"],
      baseUrls: ["api.anthropic.com"],
      calls: [
        "messages.create",
        "messages.stream",
        "messages.parse",
        "messages.count_tokens",
        "messages.countTokens",
        "beta.messages.create",
        "beta.messages.stream",
        "completions.create",
      ],
    },
    apiVersionHeader: "anthropic-version",
  },
  {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    slug: "google-gemini",
    name: "Google Gemini",
    homepage: "https://ai.google.dev/gemini-api/docs",
    logo: { light: "/logos/gemini.svg", dark: "/logos/gemini.svg" },
    officialDomains: ["ai.google.dev"],
    sources: [
      {
        kind: "deprecations",
        url: "https://ai.google.dev/gemini-api/docs/deprecations.md.txt",
        adapter: "gemini-deprecations",
      },
    ],
    sdks: [
      { ecosystem: "npm", name: "@google/genai" },
      { ecosystem: "npm", name: "@google/generative-ai" },
      { ecosystem: "npm", name: "@ai-sdk/google" },
      { ecosystem: "npm", name: "@langchain/google-genai" },
      { ecosystem: "pypi", name: "google-genai" },
      { ecosystem: "pypi", name: "google-generativeai" },
    ],
    detection: {
      imports: [
        "@google/genai",
        "@google/generative-ai",
        "@ai-sdk/google",
        "@langchain/google-genai",
        "google.genai",
        "google.generativeai",
        "langchain_google_genai",
      ],
      envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      baseUrls: ["generativelanguage.googleapis.com"],
      calls: [
        "models.generate_content",
        "models.generate_content_stream",
        "models.count_tokens",
        "models.embed_content",
        "models.generateContent",
        "models.generateContentStream",
        "models.countTokens",
        "models.embedContent",
        "getGenerativeModel",
        "GenerativeModel",
      ],
    },
  },
  {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    slug: "nebius-token-factory",
    name: "Nebius Token Factory",
    homepage: "https://docs.tokenfactory.nebius.com",
    logo: { light: "/logos/nebius-light.svg", dark: "/logos/nebius-dark.svg" },
    officialDomains: ["docs.tokenfactory.nebius.com", "tokenfactory.nebius.com"],
    sources: [
      {
        kind: "notices-index",
        url: "https://docs.tokenfactory.nebius.com/llms.txt",
        adapter: "tokenfactory-notices",
      },
    ],
    // OpenAI-compatible: reached through the OpenAI SDKs with a Token Factory base URL.
    sdks: [
      { ecosystem: "npm", name: "openai" },
      { ecosystem: "pypi", name: "openai" },
    ],
    detection: {
      imports: [],
      envVars: ["NEBIUS_API_KEY"],
      baseUrls: ["api.tokenfactory.nebius.com", "api.tokenfactory.us-central1.nebius.com"],
      calls: [
        "chat.completions.create",
        "chat.completions.parse",
        "chat.completions.stream",
        "beta.chat.completions.parse",
        "beta.chat.completions.stream",
        "responses.create",
        "responses.parse",
        "responses.stream",
        "completions.create",
        "embeddings.create",
      ],
    },
  },
  {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    slug: "stripe",
    name: "Stripe",
    homepage: "https://docs.stripe.com",
    logo: { light: "/logos/stripe.svg", dark: "/logos/stripe.svg" },
    officialDomains: ["docs.stripe.com", "stripe.com"],
    sources: [
      { kind: "changelog", url: "https://docs.stripe.com/changelog.md", adapter: "stripe-changelog" },
    ],
    sdks: [
      { ecosystem: "npm", name: "stripe" },
      { ecosystem: "pypi", name: "stripe" },
    ],
    detection: {
      imports: ["stripe"],
      envVars: ["STRIPE_SECRET_KEY"],
      baseUrls: ["api.stripe.com"],
      calls: [],
    },
    apiVersionHeader: "Stripe-Version",
  },
];

export const PROVIDERS: readonly ProviderRecord[] = definitions.map((p) => providerRecord.parse(p));

export function providerBySlug(slug: string) {
  return PROVIDERS.find((p) => p.slug === slug);
}
