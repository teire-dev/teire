import { PR_MODE_BY_EVIDENCE } from "@teire/engine/constants";
import { Badge } from "@/components/ui/badge";

/** The run's evidence (rule 13): ready → verified green, draft → amber, issue → red. */
export function EvidenceBadge({ kind }: { kind: string | null }) {
  if (!kind) return null;
  const mode = PR_MODE_BY_EVIDENCE[kind as keyof typeof PR_MODE_BY_EVIDENCE];
  const variant = mode === "ready" ? "clear" : mode === "draft" ? "human" : "affected";
  return (
    <Badge variant={variant} className="font-mono">
      {kind.replace(/_/g, " ")}
    </Badge>
  );
}
