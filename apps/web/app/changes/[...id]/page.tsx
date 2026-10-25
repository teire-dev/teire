import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getChange, PROVIDER_NAMES } from "@/lib/catalog";
import { ClassChip } from "../class-chip";

/** One change with every source quoted, its matchers and how it was read (card C10). */
export default function ChangePage({ params }: PageProps<"/changes/[...id]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-12">
      <Link href="/changes" className="text-sm text-foreground/60 hover:underline">
        ← All changes
      </Link>
      <Suspense fallback={<p className="text-sm text-foreground/60">Loading the change…</p>}>
        <Change params={params} />
      </Suspense>
    </main>
  );
}

async function Change({ params }: { params: PageProps<"/changes/[...id]">["params"] }) {
  const { id } = await params;
  const record = await getChange(id.map(decodeURIComponent).join("/"));
  if (!record) notFound();
  const a = record.applicability;
  const matchers = record.signatures.map((s) =>
    s.kind === "string-literal"
      ? `model ID "${s.value}"`
      : s.kind === "http-operation"
        ? `${s.method === "*" ? "any method" : s.method} ${s.hostPattern}${s.pathPattern}`
        : s.kind === "call-arg"
          ? `argument ${s.arg} of ${s.callee.slice(0, 3).join(", ")}${s.callee.length > 3 ? "…" : ""}`
          : s.kind === "symbol"
            ? `${s.path} (${s.lang})`
            : s.kind === "import-path"
              ? `import ${s.value}`
              : s.kind,
  );
  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/60">
          <span>
            {PROVIDER_NAMES[record.subject.provider ?? ""] ?? record.subject.provider ?? record.subject.name}
          </span>
          <ClassChip value={a.class} />
          <span>{record.kind.replace(/-/g, " ")}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{record.title}</h1>
        <p className="text-sm text-foreground/70">{record.summary}</p>
      </header>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        {a.announcedOn ? (
          <>
            <dt className="text-foreground/60">Announced</dt>
            <dd className="font-mono">{a.announcedOn}</dd>
          </>
        ) : null}
        {a.effectiveOn ? (
          <>
            <dt className="text-foreground/60">Effective</dt>
            <dd className="font-mono">{a.effectiveOn}</dd>
          </>
        ) : null}
        {a.apiVersion?.to ? (
          <>
            <dt className="text-foreground/60">API version</dt>
            <dd className="font-mono">
              {a.apiVersion.header ? `${a.apiVersion.header}: ` : ""}
              {a.apiVersion.to}
            </dd>
          </>
        ) : null}
        {record.replacement ? (
          <>
            <dt className="text-foreground/60">Replacement</dt>
            <dd>
              <span className="font-mono">{record.replacement.value}</span>
              {record.replacement.codemod ? (
                <span className="text-foreground/60"> · Teire swaps it in code automatically</span>
              ) : null}
            </dd>
          </>
        ) : null}
        <dt className="text-foreground/60">Teire looks for</dt>
        <dd className="font-mono text-xs">
          {matchers.length ? matchers.join(" · ") : "nothing to search for: check by hand"}
        </dd>
      </dl>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">In the provider&apos;s words</h2>
        {record.sources.map((s) => (
          <figure key={`${s.url}-${s.contentHash}`} className="flex flex-col gap-1">
            {s.quote ? (
              <blockquote className="border-l-2 border-foreground/15 pl-3 font-mono text-xs text-foreground/80 break-words">
                {s.quote}
              </blockquote>
            ) : null}
            <figcaption className="text-xs text-foreground/60">
              <a href={s.url} className="underline" rel="noreferrer">
                {new URL(s.url).host}
                {new URL(s.url).pathname}
              </a>{" "}
              · checked {s.checkedAt.slice(0, 10)} · page hash{" "}
              <span className="font-mono">{s.contentHash.slice(0, 12)}</span>
            </figcaption>
          </figure>
        ))}
        {record.migrationNotes.length ? (
          <ul className="list-disc pl-5 text-sm text-foreground/70">
            {record.migrationNotes.map((n) => (
              <li key={n.text}>{n.text}</li>
            ))}
          </ul>
        ) : null}
      </section>
      <p className="text-xs text-foreground/50">
        Read by{" "}
        {record.provenance.method === "model"
          ? `a model (${record.provenance.model?.id ?? "unknown"})`
          : `code from a ${record.provenance.method}`}
        ; status {record.status}. Record <span className="font-mono">{record.id}</span>.
      </p>
    </article>
  );
}
