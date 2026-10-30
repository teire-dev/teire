import type { FixMode } from "@teire/engine/config";

/**
 * The three fix modes, said one way everywhere (plan revision 3.4, B12): the segmented control, the
 * onboarding cards, the bulk menu, the palette and the assistant's chips.
 */
export const FIX_MODES: {
  value: FixMode;
  label: string;
  /** In a dense row. */
  short: string;
  /** One line for a card: what Teire does in this mode. */
  said: string;
  tone: "proven" | "attention" | "neutral";
}[] = [
  {
    value: "auto",
    label: "Automatic",
    short: "Auto",
    said: "Fixes, verifies and opens PRs itself. You review and merge.",
    tone: "proven",
  },
  { value: "ask", label: "Ask first", short: "Ask", said: "Waits for your Fix now.", tone: "attention" },
  { value: "off", label: "Off", short: "Off", said: "Lists changes, opens nothing.", tone: "neutral" },
];

export const FIX_MODE_LABEL = Object.fromEntries(FIX_MODES.map((m) => [m.value, m.label])) as Record<
  FixMode,
  string
>;
