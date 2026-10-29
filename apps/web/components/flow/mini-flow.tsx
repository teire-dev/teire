import { Check, FileCode2, GitPullRequest, ListChecks, type LucideIcon, Wrench, X, Zap } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import type { Brand } from "@/lib/brands";
import { FLOW_STATE_LABEL, type FlowGraph, type FlowState, flowStateOf } from "@/lib/flow/model";
import { PROOF_STEPS, type Proof, type ProofStep } from "@/lib/proof";
import { cn } from "@/lib/utils";
import { outcomeIcon, TILE_ICON } from "./tile";

/**
 * The proof chain in a row (plan revision 3.4: MiniFlow replaces ProofGlyphs, ProofChain's row use
 * and PhaseStrip): five small tiles joined by short lines, the change's own mark first. A tile that
 * failed or wasn't proven shows its glyph instead of its icon, so colour is never the only signal.
 * Server component; hover names each step and screen readers get the whole chain.
 */
const ICON: Record<ProofStep, LucideIcon> = {
  changed: Zap,
  reaches: FileCode2,
  fixed: Wrench,
  proven: ListChecks,
  pr: GitPullRequest,
};

const TILE: Record<FlowState, string> = {
  pending: "bg-sheet text-ink-3 outline-dashed outline-1 outline-ink-3/55 -outline-offset-1",
  live: "bg-sheet text-signal ring-[1.5px] ring-signal animate-live",
  done: "bg-sheet text-ink ring-1 ring-ink/55",
  proven: "bg-proven text-white dark:text-sheet",
  not_proven: "bg-attention-soft text-attention ring-1 ring-attention",
  failed: "bg-broke text-white dark:text-sheet",
  skipped: "bg-sunken text-ink-3/70 outline-dashed outline-1 outline-rule-strong -outline-offset-1",
};

const LINE: Record<FlowState, string> = {
  pending: "bg-ink-3/30",
  live: "bg-signal",
  done: "bg-ink/40",
  proven: "bg-proven",
  not_proven: "bg-attention",
  failed: "bg-broke",
  skipped: "bg-rule-strong",
};

export function MiniFlow({
  proof,
  subject,
  size = "sm",
  className,
}: {
  proof: Proof;
  /** The change's mark (provider or ecosystem), drawn in the first tile instead of the bolt. */
  subject?: Brand;
  size?: "xs" | "sm";
  className?: string;
}) {
  const states = PROOF_STEPS.map((s) =>
    flowStateOf(proof[s.key].state, { verified: s.key === "proven" && proof.proven.state === "done" }),
  );
  const said = PROOF_STEPS.map((s, i) => `${s.label}: ${FLOW_STATE_LABEL[states[i] as FlowState]}`).join(
    ", ",
  );
  const box = size === "xs" ? "size-[18px] rounded-[5px]" : "size-[22px] rounded-[6px]";
  const icon = size === "xs" ? "size-2.5" : "size-3";
  return (
    <span className={cn("inline-flex items-center", className)} role="img" aria-label={said}>
      {PROOF_STEPS.map((s, i) => {
        const state = states[i] as FlowState;
        const link = proof[s.key];
        const Icon = ICON[s.key];
        return (
          <span key={s.key} className="flex items-center">
            {i > 0 ? <span aria-hidden className={cn("h-[1.5px] w-1.5", LINE[state])} /> : null}
            <span
              title={`${s.label}: ${link.detail ?? FLOW_STATE_LABEL[state]}`}
              className={cn("flex shrink-0 items-center justify-center", box, TILE[state])}
            >
              {state === "failed" ? (
                <X className={icon} strokeWidth={3} />
              ) : state === "not_proven" ? (
                <span className="font-mono text-[9px] leading-none">◐</span>
              ) : state === "proven" ? (
                <Check className={icon} strokeWidth={3} />
              ) : s.key === "changed" && subject ? (
                <BrandLogo
                  light={subject.light}
                  dark={subject.dark}
                  alt=""
                  className={cn("w-auto", size === "xs" ? "h-2.5" : "h-3")}
                />
              ) : (
                <Icon className={icon} strokeWidth={2} />
              )}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * Any flow's tiles as a MiniFlow-sized strip (a finding's change → code → fix → PR in a compact row):
 * the same small squares and short lines, the first tile's brand in place of its icon.
 */
export function GraphStrip({ graph, className }: { graph: FlowGraph; className?: string }) {
  const linkTo = new Map(graph.links.map((l) => [l.to, l.state]));
  return (
    <span
      className={cn("inline-flex items-center", className)}
      role="img"
      aria-label={graph.tiles.map((t) => `${t.label}: ${FLOW_STATE_LABEL[t.state]}`).join(", ")}
    >
      {graph.tiles.map((t, i) => {
        const Icon = t.entity === "outcome" ? outcomeIcon(t.label) : TILE_ICON[t.entity];
        return (
          <span key={t.id} className="flex items-center">
            {i > 0 ? (
              <span aria-hidden className={cn("h-[1.5px] w-2", LINE[linkTo.get(t.id) ?? t.state])} />
            ) : null}
            <span
              title={`${t.label}${t.meta ? ` · ${t.meta}` : ""}${t.caption ? ` · ${t.caption}` : ""}`}
              className={cn(
                "flex size-[22px] shrink-0 items-center justify-center rounded-[6px]",
                TILE[t.state],
              )}
            >
              {t.state === "failed" ? (
                <X className="size-3" strokeWidth={3} />
              ) : t.state === "not_proven" ? (
                <span className="font-mono text-[9px] leading-none">◐</span>
              ) : t.state === "proven" ? (
                <Check className="size-3" strokeWidth={3} />
              ) : i === 0 && t.brand ? (
                <BrandLogo light={t.brand.light} dark={t.brand.dark} alt="" className="h-3 w-auto" />
              ) : (
                <Icon className="size-3" strokeWidth={2} />
              )}
            </span>
          </span>
        );
      })}
    </span>
  );
}
