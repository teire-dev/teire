import type { ChangeV2 } from "@teire/engine/contract";
import { ArrowRight, ChevronDown, Quote as QuoteIcon, ScanSearch } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AskContext } from "@/components/assistant/assistant-provider";
import { YourChangeReach, YourReach } from "@/components/catalog/your-reach";
import { ChangeFeedback } from "@/components/change-feedback";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { StaticFlow } from "@/components/flow/static-flow";
import { Mark } from "@/components/teire/mark";
import { StatusChip } from "@/components/teire/status-chip";
import { Button } from "@/components/ui/button";
import { getChange, providerNames } from "@/lib/catalog";
import { changeLife } from "@/lib/change-flow";
import { ClassChip } from "../class-chip";

/**
 * One change (plan revision 3.4, V5): its life as a flow (source, what changes, the date, your code,
 * the fix), every source quoted, what Teire looks for as chips, and Fix in all for your repositories.
 */
/** Where a source's words come from, so a reader can weigh them (`trustBasis`, plan revision 3.3, U5). */
const TRUST_BASIS: Record<string, string> = {
  registry: "from the package registry",
  "source-repo": "from the project's own repository",
  "official-domain": "from the provider's own site",
  "advisory-db": "from an advisory database",
  computed: "computed by Teire from the published code",
  "repo-config": "declared in a repository's teire.yml",
};

export async function generateMetadata({ params }: PageProps<"/changes/[...id]">): Promise<Metadata> {
  const { id } = await params;
  const record = await getChange(id.map(decodeURIComponent).join("/"));
  if (!record) return { title: "Change" };
  const image = `/og/change/${id.join("/")}`;
  return {
    title: record.title,
    description: record.summary.slice(0, 200),
    openGraph: { images: image },
    twitter: { card: "summary_large_image", images: image },
  };
}

export default function ChangePage({ params }: PageProps<"/changes/[...id]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-12">
      <Link href="/changes" className="text-sm text-ink-3 hover:text-ink">
        ← All changes
      </Link>
      <Suspense
        fallback={
          <div className="flex h-80 items-center justify-center rounded-xl bg-sheet shadow-card" aria-hidden>
            <GhostFlow tiles={4} />
          </div>
        }
      >
        <Change params={params} />
      </Suspense>
    </main>
  );
}

function matcher(s: ChangeV2["signatures"][number]) {
  switch (s.kind) {
    case "string-literal":
      return `model ID "${s.value}"`;
    case "http-operation":
      return `${s.method === "*" ? "any method" : s.method} ${s.hostPattern}${s.pathPattern}`;
    case "call-arg":
      return `argument ${s.arg} of ${s.callee.slice(0, 3).join(", ")}${s.callee.length > 3 ? "…" : ""}`;
    case "symbol":
      return `${s.path} (${s.lang})`;
    case "import-path":
      return `import ${s.value}`;
    default:
      return s.kind;
  }
}

async function Change({ params }: { params: PageProps<"/changes/[...id]">["params"] }) {
  // The date tile counts down from now, so this renders per request (the record itself is cached).
  await connection();
  const { id } = await params;
  const [record, names] = await Promise.all([
    getChange(id.map(decodeURIComponent).join("/")),
    providerNames(),
  ]);
  if (!record) notFound();
  const { graph, logo, ownerName, ownerHref, a } = changeLife(record, names);

  return (
    <article className="flex flex-col gap-8">
      <AskContext kind="change" id={record.id} label={record.title.slice(0, 60)} />
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
          {logo ? <Mark brand={{ label: ownerName, light: logo.light, dark: logo.dark }} size="sm" /> : null}
          {ownerHref ? (
            <Link href={ownerHref} className="hover:text-ink hover:underline">
              {ownerName}
            </Link>
          ) : (
            <span>{ownerName}</span>
          )}
          <ClassChip value={a.class} />
          {record.status === "candidate" ? (
            <StatusChip tone="attention">not confirmed by its source</StatusChip>
          ) : null}
          {record.status === "quarantined" ? (
            <StatusChip tone="broke">quote failed · never applied</StatusChip>
          ) : null}
          <YourReach changeId={record.id} />
          {record.provenance.contributor ? (
            // Contributed to the catalog through a pull request (C13): who added it, linked.
            // Only a GitHub pull request URL becomes the link (S19 review B14).
            <a
              href={
                /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(
                  record.provenance.contributor.pullRequest ?? "",
                )
                  ? record.provenance.contributor.pullRequest
                  : `https://github.com/${record.provenance.contributor.login}`
              }
              className="font-mono text-[11px] text-ink-3 hover:text-ink"
            >
              added by @{record.provenance.contributor.login}
            </a>
          ) : null}
        </div>
        <h1 className="heading text-3xl text-ink">{record.title}</h1>
        <p className="text-ink-2">{record.summary}</p>
        {record.status === "quarantined" && record.quarantineReasons.length ? (
          <p className="font-mono text-xs text-broke">{record.quarantineReasons.join(" ")}</p>
        ) : null}
      </header>

      <section className="rounded-xl bg-sheet p-5 shadow-card">
        <StaticFlow graph={graph} size="sm" label={`${record.title}: from its source to your code`} />
      </section>

      <YourChangeReach changeId={record.id} />

      {/* The source's words once, folded, with its link and hash (plan revision 3.4, V5 and row 443);
          every other source a link chip beside it. */}
      <section className="flex flex-col gap-3">
        {(() => {
          const lead = record.sources.find((x) => x.quote) ?? record.sources[0];
          const rest = record.sources.filter((x) => x !== lead);
          const label = (u: string) => {
            const url = new URL(u);
            return `${url.host}${url.pathname.length > 32 ? `${url.pathname.slice(0, 31)}…` : url.pathname}`;
          };
          return (
            <>
              {lead ? (
                <details className="group/quote rounded-xl bg-sheet shadow-card">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
                    <QuoteIcon className="size-4 text-ink-3" aria-hidden />
                    <span className="font-medium text-ink">In its own words</span>
                    <span className="rounded-full bg-proven-soft px-2 py-0.5 font-mono text-[11px] text-proven">
                      {lead.quote ? "matches the page ✓" : "read from the page"}
                    </span>
                    <span className="font-mono text-[11px] text-ink-3">{new URL(lead.url).host}</span>
                    <ChevronDown
                      aria-hidden
                      className="ml-auto size-3.5 text-ink-3 transition-transform group-open/quote:rotate-180"
                    />
                  </summary>
                  <figure className="flex flex-col gap-3 border-t border-rule px-4 py-3">
                    {lead.quote ? (
                      <blockquote className="border-l-2 border-rule-strong pl-3 font-mono text-xs break-words text-ink-2">
                        {lead.quote}
                      </blockquote>
                    ) : null}
                    <figcaption className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
                      <a href={lead.url} className="text-link hover:underline" rel="noreferrer">
                        {label(lead.url)}
                      </a>
                      <span className="rounded-full bg-sunken px-2 py-0.5">
                        {TRUST_BASIS[lead.trustBasis] ?? lead.trustBasis}
                      </span>
                      <span className="font-mono">checked {lead.checkedAt.slice(0, 10)}</span>
                      <span className="font-mono" title="page hash">
                        #{lead.contentHash.slice(0, 10)}
                      </span>
                    </figcaption>
                  </figure>
                </details>
              ) : null}
              {rest.length ? (
                <ul className="flex flex-wrap gap-1.5" aria-label="Other sources">
                  {rest.map((x) => (
                    <li key={`${x.url}-${x.contentHash}`}>
                      <a
                        href={x.url}
                        rel="noreferrer"
                        title={`${TRUST_BASIS[x.trustBasis] ?? x.trustBasis} · checked ${x.checkedAt.slice(0, 10)}`}
                        className="flex items-center gap-1.5 rounded-full bg-sheet px-2.5 py-1 font-mono text-[11px] text-ink-2 shadow-tile ring-1 ring-rule hover:text-ink"
                      >
                        {label(x.url)}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          );
        })()}
        {record.migrationNotes.length ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-2">
            {record.migrationNotes.map((n) => (
              <li key={n.text}>{n.text}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-ink">
          <ScanSearch className="size-4 text-ink-3" aria-hidden />
          What Teire looks for in your code
        </h2>
        {record.signatures.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {record.signatures.map((sig) => (
              <li
                key={matcher(sig)}
                className="rounded-md bg-sheet px-2 py-1 font-mono text-[11px] text-ink-2 shadow-tile ring-1 ring-rule"
              >
                {matcher(sig)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="font-mono text-xs text-ink-3">nothing to search for: checked by hand</p>
        )}
      </section>

      <section className="flex flex-col items-start justify-between gap-4 rounded-xl bg-hero p-6 text-hero-ink sm:flex-row sm:items-center">
        <p className="display text-2xl">Does it reach your code?</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="cta" shape="pill">
            <Link href={`/app/changes?change=${encodeURIComponent(record.id)}`}>
              Fix in all
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
          <Button asChild variant="hero" shape="pill">
            <Link href="/scan">Scan a repo</Link>
          </Button>
        </div>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-4 text-[11px] text-ink-3">
        <p className="font-mono">
          {record.provenance.method === "model"
            ? `read by ${record.provenance.model?.id ?? "a model"} · checked against the page`
            : `read by a ${record.provenance.method}`}{" "}
          · {record.id}
        </p>
        <ChangeFeedback changeId={record.id} />
      </footer>
    </article>
  );
}
