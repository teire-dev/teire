import { PROOF_GLYPH, PROOF_STATE_LABEL, PROOF_STEPS, type Proof, type ProofState } from "@/lib/proof";
import { cn } from "@/lib/utils";

/**
 * Colour by meaning only: a finished step is a plain ink check; green belongs to PROVEN alone, when
 * the evidence proves it; cobalt is the step Teire is on now; amber is "ran, not proven"; red failed.
 */
function tone(step: string, state: ProofState) {
  switch (state) {
    case "done":
      return step === "proven" ? "text-proven" : "text-ink";
    case "live":
      return "text-signal";
    case "failed":
      return "text-broke";
    case "not_proven":
      return "text-attention";
    default:
      return "text-ink-3";
  }
}

function marker(step: string, state: ProofState) {
  switch (state) {
    case "done":
      return step === "proven" ? "bg-proven-soft ring-proven/30" : "bg-sheet ring-rule-strong";
    case "live":
      return "bg-signal-soft ring-signal/40";
    case "failed":
      return "bg-broke-soft ring-broke/30";
    case "not_proven":
      return "bg-attention-soft ring-attention/30";
    default:
      return "bg-sunken ring-rule";
  }
}

/**
 * The five steps with their state, detail and evidence link (a run's header, the landing hero). On a
 * phone the steps stack; the rule between two steps is solid once the first is done.
 */
export function ProofChain({ proof, className }: { proof: Proof; className?: string }) {
  return (
    <ol className={cn("grid grid-cols-1 gap-3 sm:grid-cols-5 sm:gap-0", className)} aria-label="Proof chain">
      {PROOF_STEPS.map((s, i) => {
        const link = proof[s.key];
        const next = PROOF_STEPS[i + 1];
        const solid = link.state === "done" && next && proof[next.key].state !== "pending";
        const body = (
          <>
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px] ring-1 ring-inset",
                  marker(s.key, link.state),
                  tone(s.key, link.state),
                  link.state === "live" && "animate-live",
                )}
                aria-hidden
              >
                {PROOF_GLYPH[link.state]}
              </span>
              {next ? (
                <span
                  aria-hidden
                  className={cn(
                    "hidden h-px flex-1 sm:block",
                    solid
                      ? "bg-rule-strong"
                      : "bg-[repeating-linear-gradient(to_right,var(--rule-strong)_0_3px,transparent_3px_6px)]",
                  )}
                />
              ) : null}
            </span>
            <span className="eyebrow mt-2 block text-ink-2">{s.label}</span>
            <span className={cn("mt-0.5 block truncate pr-3 text-xs", tone(s.key, link.state))}>
              {link.detail ?? PROOF_STATE_LABEL[link.state]}
            </span>
            <span className="sr-only">
              {s.label}: {PROOF_STATE_LABEL[link.state]}
              {link.detail ? `, ${link.detail}` : ""}
            </span>
          </>
        );
        return (
          <li key={s.key} className="min-w-0">
            {link.href ? (
              <a
                href={link.href}
                className="group block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {body}
              </a>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The chain in a row: five glyphs in mono, each with its step and state on hover and for screen
 * readers ("✓ ✓ ● ○ ○"). Status colour never appears below 12px without its glyph.
 */
export function ProofGlyphs({ proof, className }: { proof: Proof; className?: string }) {
  const said = PROOF_STEPS.map((s) => `${s.label}: ${PROOF_STATE_LABEL[proof[s.key].state]}`).join(", ");
  return (
    <span
      className={cn("inline-flex items-center gap-1 font-mono text-xs", className)}
      role="img"
      aria-label={said}
    >
      {PROOF_STEPS.map((s) => {
        const link = proof[s.key];
        return (
          <span
            key={s.key}
            title={`${s.label}: ${link.detail ?? PROOF_STATE_LABEL[link.state]}`}
            className={cn(
              "w-3 text-center",
              tone(s.key, link.state),
              link.state === "live" && "animate-pulse",
            )}
          >
            {PROOF_GLYPH[link.state]}
          </span>
        );
      })}
    </span>
  );
}
