import type { InferUITools, UIMessage } from "ai";
import type { AssistantTools } from "./tools";

/**
 * Ask Teire's messages (AI SDK UI messages): what a reply cost and whether it finished ride in its
 * metadata; a budget or model notice is a data part; tool results are typed by the tools, so each
 * card reads exactly what its tool returned. Types only: the client imports nothing from the server.
 */
export interface AssistantMetadata {
  createdAt?: number;
  model?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** The reply stopped before it finished (Stop, a closed tab, the time limit). */
  interrupted?: boolean;
  /** Helpful (1) or not (-1), from the person. */
  rating?: 1 | -1;
}

export interface AssistantNotice {
  kind: "budget" | "model-down";
  message: string;
  /** Docs search results, labelled as search results, not as a model's answer. */
  results?: { title: string; url: string; snippet: string }[];
}

export type AssistantDataParts = { notice: AssistantNotice };

export type AssistantMessage = UIMessage<AssistantMetadata, AssistantDataParts, InferUITools<AssistantTools>>;

/** What the page the person is on adds to a question (the context chip). */
export interface AssistantContext {
  kind: "repo" | "run" | "change";
  id: string;
  label: string;
}
