import { Connector } from "@/components/flow/static-flow";
import { cn } from "@/lib/utils";

/**
 * A flow still on its way (plan revision 3.4: loading and empty states draw the flow in ghost state):
 * pending tiles shimmering on a dashed line. Decorative; the page says "Loading" to screen readers.
 */
const GHOSTS = ["a", "b", "c", "d", "e", "f", "g", "h"];

export function GhostFlow({ tiles = 4, className }: { tiles?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("flex items-center [--tile:48px]", className)}>
      {GHOSTS.slice(0, tiles).map((id, i) => (
        <span key={id} className="flex items-center">
          {i > 0 ? <Connector axis="x" link={{ state: "pending" }} /> : null}
          <span className="size-12 shrink-0 rounded-[14px] shimmer outline-dashed outline-[1.5px] -outline-offset-[1.5px] outline-ink-3/35" />
        </span>
      ))}
    </div>
  );
}
