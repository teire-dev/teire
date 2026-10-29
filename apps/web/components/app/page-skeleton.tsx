/** A dashboard page's shape while it loads: a heading, then sheets (plan "every route gets loading"). */
export function PageSkeleton({ rows = 6, aside = false }: { rows?: number; aside?: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6" role="status" aria-label="Loading">
      <div className="h-4 w-24 animate-pulse rounded bg-sunken" />
      <div className="h-8 w-64 animate-pulse rounded-lg bg-sunken" />
      <div className={aside ? "grid gap-6 lg:grid-cols-[1fr_340px]" : "flex flex-col"}>
        <div className="flex flex-col divide-y divide-rule overflow-hidden rounded-xl bg-sheet shadow-card">
          {Array.from({ length: rows }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <div className="size-7 animate-pulse rounded-md bg-sunken" />
              <div className="h-3 flex-1 animate-pulse rounded bg-sunken" />
              <div className="h-3 w-20 animate-pulse rounded bg-sunken" />
            </div>
          ))}
        </div>
        {aside ? <div className="h-72 animate-pulse rounded-xl bg-sheet shadow-card" /> : null}
      </div>
    </div>
  );
}
