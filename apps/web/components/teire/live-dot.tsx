import { cn } from "@/lib/utils";

/**
 * Teire is working here right now: a cobalt dot whose ring pulses. It means active work and nothing
 * else (plan revision 3.3, signature detail 3). Reduced motion keeps the dot and drops the pulse.
 */
export function LiveDot({ label = "Teire is working", className }: { label?: string; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} role="img" aria-label={label}>
      <span className="size-2 rounded-full bg-signal animate-live" />
    </span>
  );
}
