import type OpenAI from "openai";

/** Reads the status of an assistant run on a support thread. */
export async function runStatus(client: OpenAI, threadId: string, runId: string): Promise<string> {
  const run = await client.beta.threads.runs.retrieve(threadId, runId);
  return run.status;
}
