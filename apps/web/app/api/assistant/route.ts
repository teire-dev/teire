import { ASSISTANT } from "@teire/engine/constants";
import {
  createTokenFactory,
  nemotronOptions,
  nemotronSampling,
  receiptFor,
  tokenFactoryConfigFromEnv,
} from "@teire/engine/llm";
import {
  consumeStream,
  convertToModelMessages,
  createIdGenerator,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  type LanguageModelUsage,
  streamText,
  toUIMessageStream,
  validateUIMessages,
} from "ai";
import { priceOf, reserve, settle } from "@/lib/assistant/budget";
import type { AssistantContext, AssistantMessage, AssistantMetadata } from "@/lib/assistant/message";
import { instructionsFor } from "@/lib/assistant/prompt";
import {
  dropFrom,
  isMessageId,
  isThreadId,
  messagesOf,
  openThread,
  ownerOf,
  saveMessage,
} from "@/lib/assistant/threads";
import { assistantTools } from "@/lib/assistant/tools";
import { readableRepo, type Viewer, viewerOf } from "@/lib/assistant/viewer";
import { getChange } from "@/lib/catalog";
import { searchDocs } from "@/lib/docs-search";
import { runSheet } from "@/lib/run-sheet";

/**
 * Ask Teire's reply (plan revision 3.3, U4): Nemotron 3 Super on Token Factory, streamed with its tool
 * steps. Stop (or a closed tab) aborts the model through the request's signal, and the partial reply
 * is still stored, marked interrupted (`consumeSseStream`). Each reply is reserved against the
 * assistant's own budget before the model runs and settled to its real cost after.
 */
export const maxDuration = 90;

const newId = createIdGenerator({ prefix: "msg", size: 16 });

const DOCS_TOOLS = ["search_docs", "list_changes", "get_change", "show_steps", "offer_choices"] as const;

/** The page's context chip, kept only when the person can read what it names. */
async function contextOf(viewer: Viewer, raw: unknown): Promise<AssistantContext | null> {
  const c = raw as Partial<AssistantContext> | null;
  if (!c || typeof c.id !== "string" || typeof c.label !== "string" || c.id.length > 300) return null;
  const label = c.label.slice(0, 120);
  if (c.kind === "repo")
    return "error" in (await readableRepo(viewer, c.id)) ? null : { kind: "repo", id: c.id, label };
  if (c.kind === "run") {
    const sheet = /^[0-9a-f-]{36}$/.test(c.id) ? await runSheet(c.id) : null;
    if (!sheet || "error" in (await readableRepo(viewer, sheet.repo.fullName))) return null;
    return { kind: "run", id: c.id, label };
  }
  if (c.kind === "change") return (await getChange(c.id)) ? { kind: "change", id: c.id, label } : null;
  return null;
}

/** What a person typed: text only (files and tool parts from a client are dropped). */
function userMessage(raw: unknown): AssistantMessage | null {
  const m = raw as { id?: unknown; role?: unknown; parts?: unknown } | null;
  if (m?.role !== "user" || !isMessageId(m.id) || !Array.isArray(m.parts)) return null;
  const text = m.parts
    .filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()
    .slice(0, 4_000);
  return text ? { id: m.id, role: "user", parts: [{ type: "text", text }] } : null;
}

const textOf = (m: AssistantMessage | null) =>
  m?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ") ?? "";

export async function POST(request: Request) {
  const viewer = await viewerOf(request);
  if (!viewer) return Response.json({ error: "Sign in to ask Teire" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !isThreadId(body.id)) return Response.json({ error: "bad request" }, { status: 400 });
  const mode = body.mode === "docs" ? "docs" : "app";
  const regenerate = body.trigger === "regenerate-message";
  const message = regenerate ? null : userMessage(body.message);
  if (!regenerate && !message) return Response.json({ error: "Ask something first" }, { status: 400 });

  const owner = ownerOf(viewer.userId);
  const context = await contextOf(viewer, body.context);
  const thread = await openThread({
    owner,
    id: body.id,
    installationId: viewer.scope?.installationId ?? null,
    context,
    firstText: textOf(message),
  });
  if (!thread) return Response.json({ error: "No such thread" }, { status: 404 });
  if (regenerate && isMessageId(body.messageId)) await dropFrom(thread.id, body.messageId);
  if (message) await saveMessage(thread.id, message);

  const all = assistantTools(viewer);
  const tools =
    mode === "docs"
      ? (Object.fromEntries(DOCS_TOOLS.map((k) => [k, all[k]])) as Pick<
          typeof all,
          (typeof DOCS_TOOLS)[number]
        >)
      : all;
  // The stored thread, checked against today's tools; a message that no longer fits is left out.
  const stored = await messagesOf(thread.id);
  const messages = (
    await Promise.all(
      stored.map((m) =>
        validateUIMessages<AssistantMessage>({ messages: [m], tools: all })
          .then((ok) => ok)
          .catch(() => [] as AssistantMessage[]),
      ),
    )
  ).flat();

  const tf = createTokenFactory(tokenFactoryConfigFromEnv());
  const model = tf.modelId("assistant");
  const reservation = await reserve({ userId: viewer.userId, threadId: thread.id, model });

  // Budget reached: said plainly, with docs search results labelled as search results.
  if ("blocked" in reservation) {
    const docs = await searchDocs(textOf(message) || "Ask Teire").catch(() => ({ results: [] }));
    const stream = createUIMessageStream<AssistantMessage>({
      originalMessages: messages,
      generateId: newId,
      execute: ({ writer }) => {
        writer.write({ type: "start", messageMetadata: { createdAt: Date.now() } });
        writer.write({
          type: "data-notice",
          data: { kind: "budget", message: reservation.blocked, results: docs.results.slice(0, 4) },
        });
        writer.write({ type: "finish" });
      },
      onEnd: async ({ responseMessage }) => {
        await saveMessage(thread.id, responseMessage);
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  const price = await priceOf(model);
  const started = Date.now();
  let usage: LanguageModelUsage | null = null;
  const receipt = () => receiptFor(usage ?? ({} as LanguageModelUsage), price);

  const result = streamText({
    model: tf.model("assistant"),
    instructions: instructionsFor({
      mode,
      name: viewer.name,
      account: viewer.account,
      context: context ?? (thread.context as AssistantContext | null),
    }),
    messages: await convertToModelMessages(messages, { tools: all, ignoreIncompleteToolCalls: true }),
    tools,
    stopWhen: isStepCount(ASSISTANT.maxSteps),
    maxOutputTokens: ASSISTANT.maxOutputTokens,
    abortSignal: request.signal,
    timeout: { totalMs: ASSISTANT.replyMs },
    ...nemotronSampling,
    providerOptions: nemotronOptions({ thinking: false }),
    onEnd: ({ usage: total }) => {
      usage = total;
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      generateMessageId: newId,
      sendReasoning: false,
      messageMetadata: ({ part }): AssistantMetadata | undefined => {
        if (part.type === "start") return { createdAt: Date.now(), model };
        if (part.type === "finish") {
          usage = part.totalUsage;
          const r = receipt();
          return { tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: Number(r.costUsd.toFixed(5)) };
        }
        return undefined;
      },
      onError: (error) => {
        console.error("[assistant]", error);
        return "Nemotron didn't answer this time. Try again, or search the docs.";
      },
      onEnd: async ({ responseMessage, isAborted, outcome }) => {
        const r = receipt();
        const interrupted = isAborted || outcome.status !== "completed";
        try {
          if (responseMessage.parts.length) {
            responseMessage.metadata = {
              ...responseMessage.metadata,
              ...(interrupted ? { interrupted: true } : {}),
            };
            await saveMessage(thread.id, responseMessage, interrupted);
          }
        } finally {
          await settle(reservation.id, {
            messageId: responseMessage.id ?? null,
            model,
            tokensIn: r.tokensIn,
            tokensOut: r.tokensOut,
            costUsd: r.costUsd,
            latencyMs: Date.now() - started,
            failed: outcome.status === "failed" && !r.tokensOut,
          });
        }
      },
    }),
    consumeSseStream: consumeStream,
  });
}
