const NAV_WIDTHS = [70, 64, 58, 52, 46, 40];

/** The kit's pages load inside the shell's frame: a sheet and rows in the shape of what's coming. */
export default function Loading() {
  return (
    <div className="flex flex-1 gap-0" role="status" aria-busy aria-label="Loading">
      <div className="hidden w-60 shrink-0 flex-col gap-3 border-r border-rule p-3 md:flex">
        <div className="h-6 w-24 animate-pulse rounded-md bg-sunken" />
        <div className="h-8 animate-pulse rounded-lg bg-sunken" />
        {NAV_WIDTHS.map((w) => (
          <div key={w} className="h-5 animate-pulse rounded bg-sunken" style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-6 p-8">
        <div className="h-8 w-48 animate-pulse rounded-md bg-sunken" />
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-rule lg:grid-cols-4">
          {["proven", "needs", "open", "reaching"].map((k) => (
            <div key={k} className="h-24 bg-sheet p-4">
              <div className="h-3 w-24 animate-pulse rounded bg-sunken" />
              <div className="mt-5 h-8 w-12 animate-pulse rounded bg-sunken" />
            </div>
          ))}
        </div>
        {["a", "b", "c", "d"].map((k) => (
          <div key={k} className="h-16 animate-pulse rounded-xl bg-sheet shadow-card" />
        ))}
      </div>
    </div>
  );
}
