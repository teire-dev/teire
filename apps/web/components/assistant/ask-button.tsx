"use client";

import { Button } from "@/components/ui/button";
import type { AssistantContext } from "@/lib/assistant/message";
import { useAssistant } from "./assistant-provider";

/**
 * Explain (plan revision 3.3: a finding's Explain, the repository's menu): opens Ask Teire with the
 * question asked and what it's about as the context chip.
 */
export function AskButton({
  question,
  context,
  children = "Explain",
  variant = "ghost",
}: {
  question: string;
  context?: AssistantContext | null;
  children?: React.ReactNode;
  variant?: "ghost" | "outline";
}) {
  const { ask, available } = useAssistant();
  if (!available) return null;
  return (
    <Button type="button" size="sm" variant={variant} onClick={() => ask(question, context)}>
      {children}
    </Button>
  );
}
