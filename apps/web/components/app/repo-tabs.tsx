"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** The repository's tabs, each its own URL (plan revision 3.3, U3), so a tab can be linked and shared. */
export function RepoTabs({
  base,
  tabs,
}: {
  base: string;
  tabs: { key: string; label: string; count?: number }[];
}) {
  const path = usePathname();
  const current = path.slice(base.length + 1).split("/")[0] || "findings";
  return (
    <nav aria-label="Repository" className="-mb-px flex gap-1 overflow-x-auto border-b border-rule">
      {tabs.map((t) => {
        const on = t.key === current;
        return (
          <Link
            key={t.key}
            href={`${base}/${t.key}`}
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
              on ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink",
            )}
          >
            {t.label}
            {t.count !== undefined ? (
              <span className="font-mono text-[11px] text-ink-3">{t.count}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
