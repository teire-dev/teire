import Link from "next/link";
import { connection } from "next/server";
import { BrandLogo } from "@/components/brand-logo";
import { listChanges } from "@/lib/catalog";
import { providerLogo } from "@/lib/logos";
import { cn } from "@/lib/utils";

const DAY = 86_400_000;

/** "in 12 days", "tomorrow", "today": the countdown a deadline dot carries. */
export function countdown(deadline: string, now = Date.now()) {
  const days = Math.ceil((Date.parse(deadline) - now) / DAY);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

/**
 * The next real deadlines in the public catalog as a rail (plan revision 3.4, B1/C5): provider marks on
 * dots along a line, each with its countdown, at most `max` and then "N more". On phones it becomes a
 * list. Cached with the catalog (hourly, and whenever the worker writes).
 */
export async function DeadlineRail({ max = 6, className }: { max?: number; className?: string }) {
  await connection();
  const today = new Date().toISOString().slice(0, 10);
  const next = (await listChanges()).filter((r) => r.deadline && r.deadline.slice(0, 10) >= today);
  if (!next.length) return null;
  const shown = next.slice(0, max);
  return (
    <div className={cn("relative", className)}>
      <span
        aria-hidden
        className="absolute top-[19px] right-6 left-6 hidden border-t-[1.5px] border-dashed border-attention/45 sm:block"
      />
      <ol className="relative grid gap-2 sm:grid-flow-col sm:auto-cols-fr sm:gap-0">
        {shown.map((r) => {
          const logo = providerLogo(r.provider);
          return (
            <li key={r.id} className="min-w-0">
              <Link
                href={`/changes/${r.id}`}
                title={r.title}
                className="group flex min-w-0 items-center gap-3 rounded-card px-2 py-1.5 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-signal sm:flex-col sm:gap-2 sm:text-center"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-sheet shadow-tile ring-[1.5px] ring-attention">
                  <BrandLogo light={logo.light} dark={logo.dark} alt={logo.name} className="h-5 max-w-7" />
                </span>
                <span className="flex min-w-0 flex-col sm:w-full sm:items-center">
                  <span data-flow className="w-full truncate font-mono text-[11px] text-ink-2 sm:px-1">
                    {(r.record.subject?.name ?? r.title).split("/").at(-1)}
                  </span>
                  <span data-flow className="text-[11px] font-medium text-attention">
                    {countdown(r.deadline as string)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      {next.length > shown.length ? (
        <Link
          href="/changes"
          className="mt-2 inline-block text-xs text-link hover:underline sm:absolute sm:-top-6 sm:right-2 sm:mt-0"
        >
          {next.length - shown.length} more ›
        </Link>
      ) : null}
    </div>
  );
}
