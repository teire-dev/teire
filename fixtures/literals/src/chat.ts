import OpenAI from "openai";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

const client = new OpenAI({ baseURL: process.env.OPENAI_BASE_URL });
const CHAT_MODEL = process.env.CHAT_MODEL ?? "gpt-4";

export async function reply(text: string) {
  const r = await client.chat.completions.create({ model: "gpt-4-0613", messages: [{ role: "user", content: "gpt-4 is not a model here" }] });
  await generateText({ model: openai("gpt-3.5-turbo-0125"), prompt: text });
  return fetch("https://api.openai.com/v1/engines", { method: "GET" }).then(() => r);
}

export const label = "gpt-4";
