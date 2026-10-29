"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Brand } from "@/lib/brands";
import { cn } from "@/lib/utils";

/**
 * One list filter as a dropdown that lives in the URL (plan revision 3.4, V4: a row of four
 * dropdowns instead of rows of chips). Each option is the page it leads to, so a filtered list can be
 * linked; a set filter reads as a filled chip.
 */
export function FilterSelect({
  label,
  value,
  options,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; href: string; brand?: Brand }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const on = value !== (options[0]?.value ?? "all");
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        const o = options.find((x) => x.value === v);
        if (o) start(() => router.push(o.href, { scroll: false }));
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        className={cn(
          "rounded-full border-0 bg-sheet px-3 text-xs text-ink-2 shadow-tile ring-1 ring-rule hover:text-ink",
          on && "bg-ink text-sheet ring-ink hover:text-sheet [&_svg]:!text-sheet/70",
          pending && "opacity-70",
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.brand ? (
              <BrandLogo light={o.brand.light} dark={o.brand.dark} alt="" className="size-3.5 w-auto" />
            ) : null}
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
