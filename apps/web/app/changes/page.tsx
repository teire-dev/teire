import Link from "next/link";
import { Suspense } from "react";
import { listChanges, PROVIDER_NAMES } from "@/lib/catalog";
import { ClassChip } from "./class-chip";

export const metadata = {
  title: "Changes · Teire",
  description:
    "Model retirements, removed endpoints and API changes from the providers, quoted from their own pages.",
};

/** Public catalog of provider changes, each with the provider's own words (card C10). */
export default function ChangesPage({ searchParams }: PageProps<"/changes">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Changes</h1>
        <p className="text-sm text-foreground/70">
          Model retirements, removed endpoints and API changes, read from each provider&apos;s own pages and
          quoted word for word. Teire checks every quote against the page it came from before a change is
          applied to code.
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-foreground/60">Loading changes…</p>}>
        <ChangeList searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function ChangeList({ searchParams }: { searchParams: PageProps<"/changes">["searchParams"] }) {
  const params = await searchParams;
  const provider =
    typeof params.provider === "string" && params.provider in PROVIDER_NAMES ? params.provider : null;
  const rows = await listChanges(provider);
  return (
    <>
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter by provider">
        <Link
          href="/changes"
          className={`rounded-full border px-3 py-1 ${provider ? "border-foreground/15 text-foreground/70" : "border-foreground bg-foreground text-background"}`}
        >
          All
        </Link>
        {Object.entries(PROVIDER_NAMES).map(([slug, name]) => (
          <Link
            key={slug}
            href={`/changes?provider=${slug}`}
            className={`rounded-full border px-3 py-1 ${provider === slug ? "border-foreground bg-foreground text-background" : "border-foreground/15 text-foreground/70"}`}
          >
            {name}
          </Link>
        ))}
      </nav>
      <p className="text-sm text-foreground/60">
        {rows.length} change{rows.length === 1 ? "" : "s"}
        {provider ? ` from ${PROVIDER_NAMES[provider]}` : ""}
      </p>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-foreground/10 p-6 text-sm text-foreground/70">
          No confirmed changes{provider ? ` from ${PROVIDER_NAMES[provider]}` : ""} yet. Teire reads each
          provider&apos;s deprecation pages every three hours.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-foreground/10 rounded-lg border border-foreground/10">
          {rows.map((r) => {
            const quote = r.record.sources.find((s) => s.quote)?.quote;
            return (
              <li key={r.id} className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/60">
                  <span>{PROVIDER_NAMES[r.provider ?? ""] ?? r.provider}</span>
                  <ClassChip value={r.class} />
                  {r.deadline ? <span className="font-mono">{r.deadline}</span> : null}
                </div>
                <Link href={`/changes/${r.id}`} className="font-medium hover:underline">
                  {r.title}
                </Link>
                {r.record.replacement ? (
                  <p className="text-sm text-foreground/70">
                    Replacement: <span className="font-mono">{r.record.replacement.value}</span>
                  </p>
                ) : null}
                {quote ? (
                  <blockquote className="border-l-2 border-foreground/15 pl-3 font-mono text-xs text-foreground/70 break-words">
                    {quote.length > 280 ? `${quote.slice(0, 280)}…` : quote}
                  </blockquote>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
