"use client";

import { cardFor } from "@/components/assistant/assistant-chat";

/** One Ask Teire card as the thread draws it, from a tool's real output (choices pick nothing here). */
export function KitCard({ name, output }: { name: string; output: unknown }) {
  return cardFor(name, output, () => {}, false);
}
