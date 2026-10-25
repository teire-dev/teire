import type { ChangeV2 } from "@teire/engine/contract";
import { ArrowRight, Flag } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { Button } from "@/components/ui/button";
import { ecosystemOf } from "@/lib/brands";
import { getChange, providerNames } from "@/lib/catalog";
import { providerLogo } from "@/lib/logos";
import { SOURCE_URL } from "@/lib/site";
import { ClassChip } from "../class-chip";

/** One change with every source quoted, what Teire searches for, and how it was read (C10). */
export default function ChangePage({ params }: PageProps<"/changes/[...id]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-12">
      <Link href="/changes" className="text-sm text-muted-foreground hover:text-foreground">
        ← All changes
      </Link>
      <Suspense fallback={<div className="h-80 animate-pulse rounded-lg bg-muted" aria-hidden />}>
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
  const { id } = await params;
  const [record, names] = await Promise.all([
    getChange(id.map(decodeURIComponent).join("/")),
    providerNames(),
  ]);
  if (!record) notFound();
  const a = record.applicability;
  const provider = record.subject.provider ?? null;
  const eco = ecosystemOf(record.subject.ecosystem);
  const logo = provider ? providerLogo(provider) : eco ? { light: eco.light, dark: eco.dark } : null;
  const ownerHref = provider
    ? `/providers/${provider}`
    : record.subject.ecosystem
      ? `/packages/${record.subject.ecosystem}/${encodeURIComponent(record.subject.name)}`
      : null;
  const ownerName = provider ? (names[provider] ?? provider) : record.subject.name;
  const from = record.signatures.find((s) => s.kind === "string-literal")?.value ?? a.fromVersion ?? null;
  const report = `${SOURCE_URL}/issues/new?${new URLSearchParams({
    title: `Wrong change data: ${record.id}`,
    body: `Change: ${record.id}\nTitle: ${record.title}\n\nWhat is wrong, with a link to the source:\n`,
  })}`;

  return (
    <article className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {logo ? <BrandLogo light={logo.light} dark={logo.dark} alt="" className="h-4" /> : null}
          {ownerHref ? (
            <Link href={ownerHref} className="entity-link hover:text-foreground">
              {ownerName}
            </Link>
          ) : (
            <span>{ownerName}</span>
          )}
          <ClassChip value={a.class} />
          <span>{record.kind.replace(/-/g, " ")}</span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{record.title}</h1>
        <p className="text-subtle">{record.summary}</p>
        {record.status === "candidate" ? (
          <p className="rounded-md bg-human-soft px-3 py-2 text-sm text-human">
            Not confirmed by the source yet: Teire computed this from the published code, and no release note
            quotes it. A fix for it is still proven in the sandbox like any other.
          </p>
        ) : record.status === "quarantined" ? (
          <p className="rounded-md bg-affected-soft px-3 py-2 text-sm text-affected">
            Unconfirmed: this record failed the quote check, so Teire never applies it to code.
            {record.quarantineReasons.length ? ` ${record.quarantineReasons.join(" ")}` : ""}
          </p>
        ) : null}
      </header>

      {record.replacement || a.effectiveOn ? (
        <section className="grid gap-px overflow-hidden rounded-lg bg-border shadow-card sm:grid-cols-2">
          {record.replacement ? (
            <div className="flex flex-col gap-2 bg-card p-5">
              <p className="text-xs text-muted-foreground">Replacement</p>
              <p className="font-mono text-lg">
                {from ? (
                  <span className="text-muted-foreground line-through decoration-affected/60">{from}</span>
                ) : null}
                {from ? " → " : ""}
                {record.replacement.value}
              </p>
              {record.replacement.codemod ? (
                <p className="text-xs text-muted-foreground">Teire makes this swap in code itself.</p>
              ) : null}
            </div>
          ) : null}
          {a.effectiveOn ? (
            <div className="flex flex-col gap-2 bg-card p-5">
              <p className="text-xs text-muted-foreground">
                {a.class === "already-broken" ? "Stopped working" : "Effective"}
              </p>
              <p className="font-mono text-lg text-human">{a.effectiveOn.slice(0, 10)}</p>
              {a.announcedOn ? (
                <p className="text-xs text-muted-foreground">Announced {a.announcedOn.slice(0, 10)}</p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">In the source&apos;s own words</h2>
        {record.sources.map((s) => (
          <figure
            key={`${s.url}-${s.contentHash}`}
            className="flex flex-col gap-2 rounded-lg bg-card p-4 shadow-card"
          >
            {s.quote ? (
              <blockquote className="border-l-2 pl-3 font-mono text-xs break-words text-subtle">
                {s.quote}
              </blockquote>
            ) : null}
            <figcaption className="text-xs text-muted-foreground">
              <a href={s.url} className="text-link hover:underline" rel="noreferrer">
                {new URL(s.url).host}
                {new URL(s.url).pathname}
              </a>{" "}
              · checked {s.checkedAt.slice(0, 10)} · page hash{" "}
              <span className="font-mono">{s.contentHash.slice(0, 12)}</span>
            </figcaption>
          </figure>
        ))}
        {record.migrationNotes.length ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-subtle">
            {record.migrationNotes.map((n) => (
              <li key={n.text}>{n.text}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">What Teire searches your code for</h2>
        <p className="font-mono text-xs break-words text-muted-foreground">
          {record.signatures.length
            ? record.signatures.map(matcher).join(" · ")
            : "nothing to search for: check by hand"}
        </p>
      </section>

      <section className="flex flex-col items-start justify-between gap-4 rounded-lg bg-card p-5 shadow-card sm:flex-row sm:items-center">
        <div>
          <p className="font-medium">Does this reach your code?</p>
          <p className="text-sm text-muted-foreground">
            Scan a public repository, or run the Teire CLI on your own checkout.
          </p>
        </div>
        <Button asChild>
          <Link href="/scan">
            Check a repository
            <ArrowRight data-icon="inline-end" />
          </Link>
        </Button>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground">
        <p>
          Read by{" "}
          {record.provenance.method === "model"
            ? `a model (${record.provenance.model?.id ?? "unknown"}), then checked against the page`
            : `code from a ${record.provenance.method}`}
          . Record <span className="font-mono">{record.id}</span>.
        </p>
        <a href={report} className="flex items-center gap-1 hover:text-foreground">
          <Flag className="size-3" aria-hidden />
          Report wrong data
        </a>
      </footer>
    </article>
  );
}
