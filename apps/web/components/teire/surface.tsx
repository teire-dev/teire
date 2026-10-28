import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * A sheet on the desk: white (or near-black) on the canvas, held by a 1px rule, never a shadow. An
 * optional header carries a mono eyebrow, a title and a "Go to … ›" link (The Org's sectioned home).
 */
export function Surface({
  eyebrow,
  title,
  action,
  children,
  className,
  flush,
}: {
  eyebrow?: string;
  title?: React.ReactNode;
  action?: { label: string; href: string };
  children: React.ReactNode;
  className?: string;
  /** No inner padding: tables and row lists run edge to edge. */
  flush?: boolean;
}) {
  return (
    <section className={cn("flex flex-col rounded-lg bg-sheet shadow-card", className)}>
      {eyebrow || title || action ? (
        <header className="flex items-start justify-between gap-4 border-b border-rule px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
            {title ? <h2 className="heading truncate text-sm text-ink">{title}</h2> : null}
          </div>
          {action ? (
            <Link
              href={action.href}
              className="flex shrink-0 items-center gap-0.5 text-xs text-ink-2 hover:text-ink focus-visible:text-ink"
            >
              {action.label}
              <ChevronRight className="size-3.5" aria-hidden />
            </Link>
          ) : null}
        </header>
      ) : null}
      <div className={cn(flush ? "" : "p-4")}>{children}</div>
    </section>
  );
}
