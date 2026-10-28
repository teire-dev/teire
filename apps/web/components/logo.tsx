import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Teire's mark. 手入れ (teire) is tending: the care a gardener gives a tree. The mark is a check
 * whose long stroke is a leaf, tended and proven in one shape, white on an ink tile.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-6 shrink-0", className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-ink" />
      <path
        d="M8.6 16.9 13.6 21.6"
        className="stroke-sheet"
        fill="none"
        strokeWidth="2.8"
        strokeLinecap="round"
      />
      <path
        d="M12.6 20.7C14.5 14.2 19.1 10.2 24.6 9.1 24.4 14.6 20.6 20.4 14.7 22.6Z"
        className="fill-sheet"
      />
      <path
        d="M14.3 20.9 21.9 12.3"
        className="stroke-ink"
        fill="none"
        strokeWidth="0.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link
      href={href}
      className={cn("flex items-center gap-2 text-[15px] font-semibold tracking-tight", className)}
      aria-label="Teire home"
    >
      <LogoMark />
      <span>Teire</span>
    </Link>
  );
}
