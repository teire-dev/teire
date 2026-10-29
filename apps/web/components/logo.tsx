import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Teire's mark. 手入れ (teire) is tending: the care a gardener gives a tree. The mark is a check
 * whose long stroke is a leaf, tended and proven in one shape: a white check, a chartreuse leaf, on
 * a navy tile (the favicon drops the white for two colours that hold at 16px).
 */
export function LogoMark({ className, tone = "brand" }: { className?: string; tone?: "brand" | "hero" }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-6 shrink-0", className)} aria-hidden>
      <rect width="32" height="32" rx="8" className={tone === "hero" ? "fill-hero-ink" : "fill-brand"} />
      <path
        d="M8.6 16.9 13.6 21.6"
        className={tone === "hero" ? "stroke-hero" : "stroke-white"}
        fill="none"
        strokeWidth="2.8"
        strokeLinecap="round"
      />
      <path
        d="M12.6 20.7C14.5 14.2 19.1 10.2 24.6 9.1 24.4 14.6 20.6 20.4 14.7 22.6Z"
        className={tone === "hero" ? "fill-hero" : "fill-cta"}
      />
      <path
        d="M14.3 20.9 21.9 12.3"
        className={tone === "hero" ? "stroke-hero-ink" : "stroke-brand"}
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
