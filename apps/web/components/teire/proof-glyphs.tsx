import { PROOF_GLYPH, PROOF_STATE_LABEL, PROOF_STEPS, type Proof, type ProofState } from "@/lib/proof";
import { cn } from "@/lib/utils";

/**
 * Each state's fill and glyph: colour is never the only signal (plan "Signature details": no status
 * colour below 12px without its glyph; review round 2). Ink for done, green only where the evidence
 * proves it, cobalt where Teire is now.
 */
const SEGMENT: Record<ProofState, string> = {
  done: "bg-ink text-sheet",
  live: "bg-signal text-sheet animate-live",
  failed: "bg-broke text-sheet",
  not_proven: "bg-attention text-sheet",
  pending: "bg-sheet text-ink-3 ring-1 ring-ink-3/80 ring-inset",
  not_applicable: "bg-sunken text-ink-3 ring-1 ring-rule ring-inset",
};

/**
 * The chain in a row: five glyph cells read left to right like a progress rail. Hover names each
 * step; screen readers get every step and state. A server component: rows don't ship motion.
 */
export function ProofGlyphs({ proof, className }: { proof: Proof; className?: string }) {
  const said = PROOF_STEPS.map((s) => `${s.label}: ${PROOF_STATE_LABEL[proof[s.key].state]}`).join(", ");
  return (
    <span className={cn("inline-flex items-center gap-[3px]", className)} role="img" aria-label={said}>
      {PROOF_STEPS.map((s) => {
        const link = proof[s.key];
        return (
          <span
            key={s.key}
            title={`${s.label}: ${link.detail ?? PROOF_STATE_LABEL[link.state]}`}
            className={cn(
              "flex h-3.5 w-5 items-center justify-center rounded-[4px] font-mono text-[9px] leading-none",
              s.key === "proven" && link.state === "done" ? "bg-proven text-sheet" : SEGMENT[link.state],
            )}
          >
            {PROOF_GLYPH[link.state]}
          </span>
        );
      })}
    </span>
  );
}
