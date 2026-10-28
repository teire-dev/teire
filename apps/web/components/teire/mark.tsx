import { BrandLogo } from "@/components/brand-logo";
import type { Brand } from "@/lib/brands";
import { cn } from "@/lib/utils";

/** A brand's mark on a small tile: the provider or ecosystem a row is about, before any words. */
export function Mark({
  brand,
  size = "md",
  className,
}: {
  brand: Brand;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  // Wordmark brands (Nebius, NVIDIA, Stripe, Tavily) widen their tile instead of shrinking to a square.
  const wide = /nebius|nvidia|stripe|tavily/i.test(brand.light);
  const box = {
    sm: wide ? "h-6 px-1.5 rounded-md" : "size-6 rounded-md",
    md: wide ? "h-8 px-2 rounded-lg" : "size-8 rounded-lg",
    lg: wide ? "h-11 px-2.5 rounded-xl" : "size-11 rounded-xl",
  }[size];
  const logo = wide ? { sm: "h-2.5", md: "h-3", lg: "h-4" }[size] : { sm: "h-4", md: "h-5", lg: "h-7" }[size];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center bg-sheet ring-1 ring-rule ring-inset",
        box,
        className,
      )}
      title={brand.label}
    >
      <BrandLogo light={brand.light} dark={brand.dark} alt={brand.label} className={cn("w-auto", logo)} />
    </span>
  );
}

/** Several marks overlapping, for a repository's ecosystems or a deadline's providers. */
export function MarkStack({ brands, max = 4 }: { brands: Brand[]; max?: number }) {
  const shown = brands.slice(0, max);
  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map((b) => (
        <Mark key={b.label} brand={b} size="sm" className="ring-2 ring-sheet" />
      ))}
      {brands.length > max ? (
        <span className="flex size-6 items-center justify-center rounded-md bg-sunken font-mono text-[10px] text-ink-3 ring-2 ring-sheet">
          +{brands.length - max}
        </span>
      ) : null}
    </span>
  );
}
