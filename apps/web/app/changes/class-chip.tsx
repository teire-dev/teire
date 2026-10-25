const LABEL: Record<string, { text: string; tone: string }> = {
  "already-broken": { text: "already broken", tone: "bg-red-500/10 text-red-700 dark:text-red-400" },
  "breaks-on-date": { text: "breaks on a date", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  "breaks-on-upgrade": { text: "breaks on upgrade", tone: "bg-blue-500/10 text-blue-700 dark:text-blue-400" },
  security: { text: "security", tone: "bg-red-500/10 text-red-700 dark:text-red-400" },
  notice: { text: "notice", tone: "bg-foreground/5 text-foreground/70" },
};

/** Applicability class as a small status chip; colour only for status. */
export function ClassChip({ value }: { value: string | null }) {
  const label = LABEL[value ?? ""] ?? {
    text: value ?? "unknown",
    tone: "bg-foreground/5 text-foreground/70",
  };
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${label.tone}`}>{label.text}</span>;
}
