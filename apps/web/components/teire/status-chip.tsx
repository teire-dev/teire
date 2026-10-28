import { cn } from "@/lib/utils";

export type Tone = "proven" | "attention" | "broke" | "signal" | "neutral";

const TONE: Record<Tone, string> = {
  proven: "bg-proven-soft text-proven",
  attention: "bg-attention-soft text-attention",
  broke: "bg-broke-soft text-broke",
  signal: "bg-signal-soft text-signal",
  neutral: "bg-sunken text-ink-2 ring-1 ring-rule ring-inset",
};

const GLYPH: Record<Tone, string> = { proven: "✓", attention: "◐", broke: "✕", signal: "●", neutral: "–" };

/** A status in words with its glyph, so colour is never the only signal. Pills are for status only. */
export function StatusChip({
  tone,
  children,
  glyph = true,
  className,
}: {
  tone: Tone;
  children: React.ReactNode;
  glyph?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium",
        TONE[tone],
        className,
      )}
    >
      {glyph ? (
        <span aria-hidden className="font-mono text-[10px] leading-none">
          {GLYPH[tone]}
        </span>
      ) : null}
      {children}
    </span>
  );
}

/** The chip for a run's evidence kind: proven, a draft that names its reason, or a failure. */
export function EvidenceChip({ kind }: { kind: string | null }) {
  if (!kind) return <StatusChip tone="neutral">no evidence yet</StatusChip>;
  if (kind === "verified") return <StatusChip tone="proven">Proven</StatusChip>;
  if (["regression", "unverified", "timeout"].includes(kind))
    return (
      <StatusChip tone="broke">{kind === "regression" ? "Regression" : kind.replace(/_/g, " ")}</StatusChip>
    );
  return <StatusChip tone="attention">Draft · {kind.replace(/_/g, " ")}</StatusChip>;
}
