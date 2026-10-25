import type { Verdict } from "@teire/engine/contract";
import { Badge } from "@/components/ui/badge";

const LOOK: Record<Verdict, { label: string; variant: "affected" | "human" | "clear" | "quiet" }> = {
  affected: { label: "affected", variant: "affected" },
  needs_human: { label: "needs a human", variant: "human" },
  check_by_hand: { label: "check by hand", variant: "human" },
  inconclusive: { label: "inconclusive", variant: "quiet" },
  not_affected: { label: "not affected", variant: "clear" },
  not_applicable: { label: "not applicable", variant: "quiet" },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const look = LOOK[verdict];
  return (
    <Badge variant={look.variant} className="font-mono">
      {look.label}
    </Badge>
  );
}
