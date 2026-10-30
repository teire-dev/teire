"use client";

import { MessageCircleQuestion } from "lucide-react";
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
  icon,
}: {
  question: string;
  context?: AssistantContext | null;
  children?: React.ReactNode;
  variant?: "ghost" | "outline";
  /** Only the spark, its words on hover (a card's row of icon actions). */
  icon?: boolean;
}) {
  const { ask, available } = useAssistant();
  if (!available) return null;
  return icon ? (
    <Button
      type="button"
      size="icon-sm"
      variant={variant}
      aria-label={typeof children === "string" ? children : "Explain"}
      title={typeof children === "string" ? children : "Explain"}
      onClick={() => ask(question, context)}
    >
      <MessageCircleQuestion aria-hidden />
    </Button>
  ) : (
    <Button type="button" size="sm" variant={variant} onClick={() => ask(question, context)}>
      {children}
    </Button>
  );
}
