import type OpenAI from "openai";

/** Summarises release notes in at most three sentences. */
export async function summarise(client: OpenAI, notes: string): Promise<string> {
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Summarise these release notes in at most three sentences." },
      { role: "user", content: notes },
    ],
  });
  const text = completion.choices[0]?.message.content;
  if (!text) throw new Error("no summary returned");
  return text.trim();
}
