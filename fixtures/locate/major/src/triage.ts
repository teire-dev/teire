import type OpenAI from "openai";
import type { ParsedChatCompletion } from "openai/resources/beta/chat/completions";

export interface Triage {
  category: "billing" | "bug" | "question";
  urgent: boolean;
}

const schema = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["billing", "bug", "question"] },
    urgent: { type: "boolean" },
  },
  required: ["category", "urgent"],
  additionalProperties: false,
} as const;

/** Classifies a support ticket with structured output. */
export async function triageTicket(client: OpenAI, ticket: string): Promise<Triage> {
  const completion: ParsedChatCompletion<Triage> = await client.beta.chat.completions.parse({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Classify the support ticket." },
      { role: "user", content: ticket },
    ],
    response_format: { type: "json_schema", json_schema: { name: "triage", schema, strict: true } },
  });
  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) throw new Error("no triage returned");
  return parsed;
}
