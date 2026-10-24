/**
 * An in-house cache that happens to share names with the SDK ("beta", "chat", "completions").
 * It is not the OpenAI client; a correct upgrade must leave it alone.
 */
export const beta = {
  chat: {
    completions: {
      parse: (raw: string): Record<string, unknown> => JSON.parse(raw) as Record<string, unknown>,
    },
  },
};
