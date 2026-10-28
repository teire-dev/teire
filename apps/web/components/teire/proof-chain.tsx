"use client";

import { Check, Minus, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { PROOF_STATE_LABEL, PROOF_STEPS, type Proof, type ProofState } from "@/lib/proof";
import { cn } from "@/lib/utils";

/**
 * Colour by meaning only: a finished step is ink; green belongs to PROVEN alone, when the evidence
 * proves it; cobalt is the step Teire is on now; amber is "ran, not proven"; red failed.
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

const NODE: Record<ProofState, string> = {
  done: "bg-ink text-sheet",
  live: "bg-signal text-sheet",
  failed: "bg-broke text-sheet",
  not_proven: "bg-attention text-sheet",
  pending: "bg-sheet text-ink-3 ring-1 ring-ink-3/80 ring-inset",
  not_applicable: "bg-sunken text-ink-3 ring-1 ring-rule ring-inset",
};

function NodeIcon({ step, state }: { step: string; state: ProofState }) {
  if (state === "done") return <Check className="size-3" strokeWidth={3} />;
  if (state === "failed") return <X className="size-3" strokeWidth={3} />;
  if (state === "not_applicable") return <Minus className="size-3" />;
  if (state === "not_proven") return <span className="font-mono text-[10px] leading-none">◐</span>;
  if (state === "live") return <span className="size-1.5 rounded-full bg-sheet" />;
  return (
    <span className="font-mono text-[10px] leading-none">
      {PROOF_STEPS.findIndex((s) => s.key === step) + 1}
    </span>
  );
}

/**
 * The five steps, drawn as a rail: each node fills as its step completes and the rail between two
 * finished steps draws in; the step Teire is on pulses and a dot travels toward it. Every step links
 * to its evidence; screen readers get the step, its state and its detail.
 */
export function ProofChain({ proof, className }: { proof: Proof; className?: string }) {
  const reduce = useReducedMotion();
  const states = PROOF_STEPS.map((s) => proof[s.key].state);
  const reached = states.reduce((n, st, i) => (st !== "pending" ? i : n), 0);
  return (
    <ol className={cn("relative grid grid-cols-5", className)} aria-label="Proof chain">
      {/* The rail: grey underneath, ink drawn over it up to the last step reached. */}
      <span aria-hidden className="absolute top-3 right-[10%] left-[10%] h-px bg-rule-strong" />
      <motion.span
        aria-hidden
        className="absolute top-3 left-[10%] h-px origin-left bg-ink"
        initial={reduce ? false : { scaleX: 0.2 }}
        animate={{ scaleX: 1 }}
        transition={{ type: "spring", stiffness: 60, damping: 18, delay: 0.1 }}
        style={{ width: `${(reached / (PROOF_STEPS.length - 1)) * 80}%` }}
      />
      {PROOF_STEPS.map((s, i) => {
        const link = proof[s.key];
        const node = (
          <span className="flex flex-col items-center gap-2 text-center">
            <motion.span
              initial={reduce ? false : { scale: 0.7 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 20, delay: 0.08 * i }}
              className={cn(
                "relative z-10 flex size-6 items-center justify-center rounded-full",
                NODE[link.state],
                link.state === "live" && "animate-live",
              )}
            >
              <NodeIcon step={s.key} state={link.state} />
            </motion.span>
            {/* Read once, by the line below (review round 2: it was read twice). */}
            <span className="eyebrow text-ink-2" aria-hidden>
              {s.label}
            </span>
            <span
              className={cn("max-w-full truncate px-1 font-mono text-[11px]", tone(s.key, link.state))}
              aria-hidden
            >
              {link.detail ?? PROOF_STATE_LABEL[link.state]}
            </span>
            <span className="sr-only">
              {s.label}: {PROOF_STATE_LABEL[link.state]}
              {link.detail ? `, ${link.detail}` : ""}
            </span>
          </span>
        );
        return (
          <li key={s.key} className="min-w-0">
            {link.href ? (
              <a
                href={link.href}
                className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {node}
              </a>
            ) : (
              node
            )}
          </li>
        );
      })}
    </ol>
  );
}

export { tone as proofTone };
