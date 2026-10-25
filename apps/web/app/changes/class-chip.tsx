import { Badge } from "@/components/ui/badge";

const LABEL: Record<string, { text: string; variant: "affected" | "human" | "running" | "quiet" }> = {
  "already-broken": { text: "already broken", variant: "affected" },
  "breaks-on-date": { text: "breaks on a date", variant: "human" },
  "breaks-on-upgrade": { text: "breaks on upgrade", variant: "running" },
  security: { text: "security", variant: "affected" },
  notice: { text: "notice", variant: "quiet" },
};

/** Applicability class as a status chip (status colours appear only on data). */
export function ClassChip({ value }: { value: string | null }) {
  const label = LABEL[value ?? ""] ?? { text: value ?? "unknown", variant: "quiet" as const };
  return <Badge variant={label.variant}>{label.text}</Badge>;
}

export const CLASSES = Object.entries(LABEL).map(([value, l]) => ({ value, label: l.text }));
