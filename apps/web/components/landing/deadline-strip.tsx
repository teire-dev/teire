import Link from "next/link";
import { connection } from "next/server";
import { BrandLogo } from "@/components/brand-logo";
import { listChanges } from "@/lib/catalog";
import { providerLogo } from "@/lib/logos";

/** The next three real deadlines in the public catalog (cached hourly; refreshed when the worker writes). */
export async function DeadlineStrip() {
  await connection();
  const today = new Date().toISOString().slice(0, 10);
  const next = (await listChanges())
    .filter((r) => r.deadline && r.deadline.slice(0, 10) >= today)
    .slice(0, 3);
  if (!next.length)
    return (
      <p className="text-sm text-muted-foreground">
        No upcoming shutdowns in the catalog right now.{" "}
        <Link href="/changes" className="text-link hover:underline">
          See every change Teire has read
        </Link>
        .
      </p>
    );
  return (
    <ul className="grid gap-px overflow-hidden rounded-lg bg-border shadow-card sm:grid-cols-3">
      {next.map((r) => {
        const logo = providerLogo(r.provider);
        return (
          <li key={r.id} className="bg-card">
            <Link
              href={`/changes/${r.id}`}
              className="flex h-full flex-col gap-2 p-4 transition-colors hover:bg-accent"
            >
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <BrandLogo light={logo.light} dark={logo.dark} alt="" className="h-4" />
                {logo.name}
              </span>
              <span className="line-clamp-2 text-sm font-medium">{r.title}</span>
              <span className="mt-auto font-mono text-xs text-human">{r.deadline?.slice(0, 10)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function DeadlineStripSkeleton() {
  return (
    <div className="grid gap-px overflow-hidden rounded-lg bg-border shadow-card sm:grid-cols-3" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex h-[108px] flex-col gap-2 bg-card p-4">
          <div className="h-3 w-20 animate-pulse rounded bg-muted" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="mt-auto h-3 w-16 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
