"use client";

import { ArrowUpRight, FileCode2, GitBranch, GitCommitHorizontal } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Markdown } from "@/components/markdown";
import { TITLES } from "@/lib/activity";
import { changeHref, groupHref } from "@/lib/links";
import { blobUrl, branchUrl, codeOf, commitUrl, type Hunk, hunksOf, type RunPost } from "@/lib/run-evidence";
import type { RunSheetData } from "@/lib/run-sheet";
import { TRUST_BASIS } from "@/lib/trust";
import { cn } from "@/lib/utils";
import type { ContextItem } from "./sheet-parts";

/**
 * The run page's proof (revamp S1): every claim one click from its evidence. Your code as the exact
 * lines at the commit the run read, upstream as each source's own words with its link, the pull
 * request as its text, and the raw record as readable rows.
 */

const HUNKS_SHOWN = 8;
const SITE_FILES_SHOWN = 8;
const short = (sha: string) => sha.slice(0, 7);

/** The commits and branch a run worked on, each linked on GitHub. */
export function Commits({ sheet }: { sheet: RunSheetData }) {
  const { run, repo, artifact } = sheet;
  const head = run.headSha ?? artifact?.headSha ?? null;
  const branch = artifact?.kind === "pr" ? artifact.branch : null;
  if (!run.baseSha && !head && !branch) return null;
  const chip =
    "inline-flex items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1 text-ink-2 ring-1 ring-rule ring-inset hover:text-ink hover:ring-rule-strong";
  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
      {run.baseSha ? (
        <a href={commitUrl(repo.fullName, run.baseSha)} className={chip} title="The commit the run read">
          <GitCommitHorizontal className="size-3.5 text-ink-3" aria-hidden />
          read {short(run.baseSha)}
        </a>
      ) : null}
      {head && head !== run.baseSha ? (
        <a href={commitUrl(repo.fullName, head)} className={chip} title="The commit the run pushed">
          <GitCommitHorizontal className="size-3.5 text-ink-3" aria-hidden />
          pushed {short(head)}
        </a>
      ) : null}
      {branch ? (
        <a href={branchUrl(repo.fullName, branch)} className={chip} title="The pull request's branch">
          <GitBranch className="size-3.5 text-ink-3" aria-hidden />
          {branch}
        </a>
      ) : null}
    </div>
  );
}

interface CodeRow {
  n: number | null;
  text: string;
  tone?: "del" | "add";
}

/** A file's lines as a code block (21st Code Block's shape): the path links to the lines on GitHub. */
function CodeBlock({
  file,
  href,
  range,
  rows,
}: {
  file: string;
  href: string | null;
  range: string;
  rows: CodeRow[];
}) {
  const head = (
    <>
      <FileCode2 className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      <span className="truncate" title={file}>
        {tail(file)}
      </span>
      <span className="shrink-0 text-ink-3">{range}</span>
      {href ? (
        <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-ink-3 group-hover:text-ink" aria-hidden />
      ) : null}
    </>
  );
  return (
    <figure className="overflow-hidden rounded-card bg-sheet ring-1 ring-rule">
      {href ? (
        <a
          href={href}
          className="group flex items-center gap-2 border-b border-rule bg-sunken px-3 py-1.5 font-mono text-[11px] text-ink-2 hover:text-ink"
        >
          {head}
        </a>
      ) : (
        <figcaption className="flex items-center gap-2 border-b border-rule bg-sunken px-3 py-1.5 font-mono text-[11px] text-ink-2">
          {head}
        </figcaption>
      )}
      <pre className="overflow-x-auto py-1.5 font-mono text-[11.5px] leading-5">
        {rows.map((r, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed excerpt; line order is the identity
            key={i}
            className={cn(
              "flex min-w-fit",
              r.tone === "del" && "bg-broke-soft",
              r.tone === "add" && "bg-proven-soft",
            )}
          >
            <span className="w-11 shrink-0 pr-3 text-right text-ink-3 select-none">{r.n ?? ""}</span>
            <span
              aria-hidden
              className={cn(
                "w-3 shrink-0 select-none",
                r.tone === "del" ? "text-broke" : r.tone === "add" ? "text-proven" : "text-transparent",
              )}
            >
              {r.tone === "del" ? "−" : r.tone === "add" ? "+" : " "}
            </span>
            <code className="pr-4 whitespace-pre text-ink">{r.text || " "}</code>
          </div>
        ))}
      </pre>
    </figure>
  );
}

/** A long path keeps its file name in view: `…/providers/anthropic_spec.rb`. */
const tail = (file: string) => {
  const parts = file.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : file;
};

const rangeOf = (start: number, end: number) => (end > start ? `:${start}–${end}` : `:${start}`);

/** One changed stretch: the base commit's lines it replaced (numbered), then what replaced them. */
function HunkBlock({ hunk, repo, sha }: { hunk: Hunk; repo: string; sha: string | null }) {
  const rows: CodeRow[] = [
    ...hunk.removed.map((text, i) => ({ n: hunk.start + i, text, tone: "del" as const })),
    ...hunk.added.map((text) => ({ n: null, text, tone: "add" as const })),
  ];
  return (
    <CodeBlock
      file={hunk.file}
      href={sha && !hunk.created ? blobUrl(repo, sha, hunk.file, hunk.start, hunk.end) : null}
      range={hunk.removed.length ? rangeOf(hunk.start, hunk.end) : `:${hunk.start} (added)`}
      rows={rows.slice(0, 14)}
    />
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="eyebrow">{title}</p>
        {note ? <span className="font-mono text-[11px] text-ink-3">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * "Your code" (the lost proof the owner asked back): where the dependency is declared, the lines Teire
 * located, and the lines the fix had to change, each linked at the commit the run read.
 */
export function YourCode({ sheet }: { sheet: RunSheetData }) {
  const { run, repo } = sheet;
  const code = codeOf(sheet.events, sheet.code);
  const hunks = useMemo(() => hunksOf(run.diff), [run.diff]);
  const manifests = hunks.filter((h) => h.role === "manifest");
  const edits = hunks.filter((h) => h.role === "code");
  const lockfiles = new Set(hunks.filter((h) => h.role === "lockfile").map((h) => h.file));
  const siteSha = code.sha ?? run.baseSha;
  const byFile = new Map<string, CodeRow[]>();
  for (const s of code.sites)
    byFile.set(s.file, [...(byFile.get(s.file) ?? []), { n: s.line, text: s.snippet }]);
  const files = [...byFile.entries()];
  if (!manifests.length && !edits.length && !files.length)
    return (
      <p className="text-sm text-ink-3">
        {sheet.reach.advisory
          ? "The advisory reaches the installed version; no call site is needed to be affected."
          : run.status === "queued" || run.status === "running"
            ? "The lines show here once the run has read them."
            : "No lines were recorded for this run."}
      </p>
    );
  return (
    <div className="flex flex-col gap-5">
      {manifests.length ? (
        <Section
          title="Where it's declared"
          note={
            lockfiles.size
              ? `+ ${[...lockfiles].map((f) => f.split("/").at(-1)).join(", ")} regenerated`
              : null
          }
        >
          {manifests.map((h) => (
            <HunkBlock key={`${h.file}:${h.start}`} hunk={h} repo={repo.fullName} sha={run.baseSha} />
          ))}
        </Section>
      ) : null}
      {files.length ? (
        <Section
          title="Lines Teire located"
          note={
            code.at === "scan" && code.sha ? (
              <>
                from the latest scan ·{" "}
                <a href={commitUrl(repo.fullName, code.sha)} className="text-ink-2 hover:text-ink">
                  {short(code.sha)}
                </a>
              </>
            ) : code.total > code.sites.length ? (
              `${code.sites.length} of ${code.total}`
            ) : null
          }
        >
          {files.slice(0, SITE_FILES_SHOWN).map(([file, rows]) => (
            <CodeBlock
              key={file}
              file={file}
              href={siteSha ? blobUrl(repo.fullName, siteSha, file, rows[0]?.n ?? undefined) : null}
              range={rows.length > 1 ? ` · ${rows.length} lines` : `:${rows[0]?.n}`}
              rows={rows}
            />
          ))}
          {files.length > SITE_FILES_SHOWN ? (
            <p className="font-mono text-[11px] text-ink-3">+{files.length - SITE_FILES_SHOWN} more files</p>
          ) : null}
        </Section>
      ) : null}
      {edits.length ? (
        <Section
          title="What the fix had to change"
          note={`${edits.length} place${edits.length === 1 ? "" : "s"}`}
        >
          {edits.slice(0, HUNKS_SHOWN).map((h) => (
            <HunkBlock key={`${h.file}:${h.start}`} hunk={h} repo={repo.fullName} sha={run.baseSha} />
          ))}
          {edits.length > HUNKS_SHOWN ? (
            <p className="font-mono text-[11px] text-ink-3">
              +{edits.length - HUNKS_SHOWN} more under Changes
            </p>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

const host = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** A source's own words, open, with where they come from and when Teire checked them. */
function Quote({
  quote,
  url,
  basis,
  checkedAt,
}: {
  quote: string | null;
  url: string | null;
  basis: string | null;
  checkedAt: string | null;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {quote ? (
        <blockquote className="max-h-48 overflow-auto border-l-2 border-signal/60 pl-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
          {quote}
        </blockquote>
      ) : null}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-3">
        {url?.startsWith("https://") ? (
          <a
            href={url}
            rel="noreferrer noopener"
            target="_blank"
            className="inline-flex items-center gap-1 text-link hover:underline"
          >
            {host(url)}
            <ArrowUpRight className="size-3" aria-hidden />
          </a>
        ) : null}
        {basis ? <span>{TRUST_BASIS[basis] ?? basis}</span> : null}
        {checkedAt ? <span>checked {checkedAt.slice(0, 10)}</span> : null}
      </p>
    </div>
  );
}

/**
 * What changed upstream: the catalog changes the run answers, every source quoted and linked, then
 * what the run itself read (release notes, provider pages, docs answers), all open.
 */
export function Upstream({ sheet, context }: { sheet: RunSheetData; context: [string, ContextItem[]][] }) {
  const page = sheet.run.groupKey ? groupHref(sheet.run.groupKey) : null;
  const [head = "", ...rest] = sheet.run.groupKey?.split("/") ?? [];
  // `models/anthropic` names a provider; `npm/zod/4.6.6` a package between its ecosystem and target.
  const subject = head === "models" || head === "api" ? rest[0] : rest.slice(0, -1).join("/");
  return (
    <div className="flex flex-col gap-4">
      {page ? (
        <Link
          href={page}
          className="group flex w-fit items-center gap-1.5 rounded-full bg-sunken px-3 py-1 text-[12px] text-ink-2 ring-1 ring-rule ring-inset hover:text-ink"
        >
          {subject}'s page
          <ArrowUpRight className="size-3.5 text-ink-3 group-hover:text-ink" aria-hidden />
        </Link>
      ) : null}
      {sheet.changes.map((c) => (
        <article key={c.id} className="flex flex-col gap-2.5 rounded-card bg-sunken p-3">
          <Link href={changeHref(c.id)} className="group flex items-start gap-2">
            <span className="text-[13px] font-medium text-ink group-hover:underline">{c.title}</span>
            <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-ink-3 group-hover:text-ink" aria-hidden />
          </Link>
          {c.sources.map((s, i) => (
            <Quote
              // biome-ignore lint/suspicious/noArrayIndexKey: a change's sources keep their recorded order
              key={i}
              quote={s.quote}
              url={s.url}
              basis={s.trustBasis}
              checkedAt={s.checkedAt}
            />
          ))}
        </article>
      ))}
      {context.map(([group, items]) => (
        <Section key={group} title={group}>
          {items.slice(0, 6).map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two sources can share a title; order is stable
            <article key={`${item.title}-${i}`} className="flex flex-col gap-1.5 rounded-card bg-sunken p-3">
              <p className="text-[13px] font-medium text-ink">{item.title}</p>
              <Quote quote={item.quote} url={item.url} basis={null} checkedAt={null} />
            </article>
          ))}
        </Section>
      ))}
      {!sheet.changes.length && !context.length ? (
        <p className="text-sm text-ink-3">Recorded upstream.</p>
      ) : null}
    </div>
  );
}

/** The pull request or issue as its text: proposed by a dry run, or as Teire published it. */
export function PostView({ post, compact = false }: { post: RunPost; compact?: boolean }) {
  const what = post.kind === "issue" ? "issue" : "pull request";
  return (
    <article className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 font-mono text-[11px]",
            post.state === "proposed"
              ? "bg-sunken text-ink-2 ring-1 ring-rule ring-inset"
              : "bg-proven-soft text-proven",
          )}
        >
          {post.state === "proposed"
            ? `Proposed ${what} · nothing written to GitHub`
            : `As Teire opened the ${what}`}
        </span>
        {post.url ? (
          <a
            href={post.url}
            className="ml-auto inline-flex items-center gap-1 text-[13px] text-link hover:underline"
          >
            {post.kind === "issue" ? "Issue" : "PR"} #{post.number} on GitHub
            <ArrowUpRight className="size-3.5" aria-hidden />
          </a>
        ) : null}
      </div>
      <div
        className={cn("rounded-card bg-sheet p-4 ring-1 ring-rule", compact && "max-h-[480px] overflow-auto")}
      >
        {post.title ? <h3 className="mb-3 text-[15px] font-medium text-ink">{post.title}</h3> : null}
        <Markdown>{post.body}</Markdown>
      </div>
    </article>
  );
}

type SheetEvent = RunSheetData["events"][number];

/** One event in a line: its own words when it has them, else its fields. */
function said(e: SheetEvent) {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (typeof p.detail === "string") return p.detail;
  if (typeof p.url === "string") return `${p.number ? `#${p.number} ` : ""}${p.url}`;
  const text = JSON.stringify(p);
  return text === "{}" ? "" : text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

const since = (ms: number) =>
  ms < 60_000
    ? `+${(ms / 1000).toFixed(1)}s`
    : `+${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;

/**
 * The raw record, readable (GitHub Actions' log viewer as the pattern): one row per event with its time
 * since the run began, its step and its own words; the full payload opens beneath, and a step filter.
 */
export function EventLog({ events }: { events: SheetEvent[] }) {
  const [step, setStep] = useState<string | null>(null);
  const steps = [...new Set(events.map((e) => e.step))];
  const start = events.length ? Date.parse(events[0]?.at ?? "") : 0;
  const shown = step ? events.filter((e) => e.step === step) : events;
  const chip = (on: boolean) =>
    cn(
      "rounded-full px-2.5 py-1 font-mono text-[11px] ring-1 ring-inset",
      on ? "bg-ink text-sheet ring-ink" : "bg-sheet text-ink-2 ring-rule hover:text-ink",
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Filter by step">
        <button type="button" className={chip(step === null)} onClick={() => setStep(null)}>
          All {events.length}
        </button>
        {steps.map((s) => (
          <button
            key={s}
            type="button"
            className={chip(step === s)}
            onClick={() => setStep(step === s ? null : s)}
          >
            {s}
          </button>
        ))}
      </div>
      <ol className="max-h-[520px] divide-y divide-rule overflow-auto rounded-card ring-1 ring-rule">
        {shown.map((e) => (
          <li key={e.seq}>
            <details className="group">
              <summary className="grid cursor-pointer list-none grid-cols-[56px_minmax(0,140px)_minmax(0,1fr)] items-baseline gap-3 px-3 py-2 text-[12px] hover:bg-hover [&::-webkit-details-marker]:hidden">
                <span className="font-mono text-[11px] text-ink-3 tabular-nums">
                  {since(Date.parse(e.at) - start)}
                </span>
                <span className="truncate text-ink-2" title={`${e.step} · ${e.type}`}>
                  {TITLES[e.step]?.[1] ?? e.step}
                  {e.type !== "log" ? <span className="text-ink-3"> · {e.type}</span> : null}
                </span>
                <span className="truncate font-mono text-[11.5px] text-ink group-open:whitespace-normal">
                  {said(e)}
                </span>
              </summary>
              <pre className="mx-3 mb-3 max-h-72 overflow-auto rounded-md bg-sunken p-3 font-mono text-[11px] leading-relaxed text-ink-2">
                {JSON.stringify(e.payload, null, 2)}
              </pre>
            </details>
          </li>
        ))}
        {shown.length ? null : <li className="px-3 py-6 text-sm text-ink-3">Nothing recorded yet.</li>}
      </ol>
    </div>
  );
}
