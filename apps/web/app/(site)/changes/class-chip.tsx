import { StatusChip, type Tone } from "@/components/teire/status-chip";

const LABEL: Record<string, { text: string; tone: Tone }> = {
  "already-broken": { text: "already broken", tone: "broke" },
  "breaks-on-date": { text: "breaks on a date", tone: "attention" },
  "breaks-on-upgrade": { text: "breaks on upgrade", tone: "signal" },
  security: { text: "security", tone: "broke" },
  notice: { text: "notice", tone: "neutral" },
};

/** Applicability class as a status chip, in the state colours (plan revision 3.4, B12: StatusChip, not Badge). */
export function ClassChip({ value }: { value: string | null }) {
  const label = LABEL[value ?? ""] ?? { text: value ?? "unknown", tone: "neutral" as const };
  return <StatusChip tone={label.tone}>{label.text}</StatusChip>;
}

export const CLASSES = Object.entries(LABEL).map(([value, l]) => ({ value, label: l.text }));
