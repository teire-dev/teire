import Link from "next/link";
import { LiveDot } from "@/components/teire/live-dot";
import { ProofGlyphs } from "@/components/teire/proof-glyphs";
import { EvidenceChip } from "@/components/teire/status-chip";
import type { RunRow } from "@/lib/kit";
import { ago } from "@/lib/time";

export { ago };

/** The subject of a run in a row: `faraday 2.14.3` or `anthropic: claude-3-5-sonnet… → claude-sonnet-5-5`. */
export function subjectLine(row: Pick<RunRow, "groupKey" | "from" | "to">) {
  const [head, ...rest] = (row.groupKey ?? "").split("/");
  if (head === "models" || head === "api")
    return { name: rest[0] ?? head, versions: `${row.from ?? "?"} → ${row.to ?? "?"}` };
  return { name: rest.slice(0, -1).join("/") || head, versions: `${row.from ?? "?"} → ${row.to ?? "?"}` };
}

/**
 * One run in a list (Overview sections, Runs, a repository's runs): live dot, repository and subject,
 * the proof chain as glyphs, the evidence, and the PR. The whole row opens the run's proof sheet.
 */
export function RunRowItem({ row, href }: { row: RunRow; href: string }) {
  const subject = subjectLine(row);
  const live = row.status === "running";
  return (
    <li>
      <Link
        href={href}
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5 hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
      >
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            {live ? <LiveDot /> : null}
            <span className="truncate font-mono text-[11px] text-ink-3">{row.repo.split("/")[1]}</span>
            <span className="truncate text-sm text-ink">{subject.name}</span>
          </span>
          <span className="truncate font-mono text-[11px] text-ink-3">{subject.versions}</span>
        </span>
        <ProofGlyphs proof={row.proof} className="justify-self-end" />
        <span className="hidden sm:block">
          {live ? (
            <span className="text-xs text-signal">{row.step ?? "running"}</span>
          ) : (
            <EvidenceChip kind={row.evidence} />
          )}
        </span>
        <span
          className="hidden w-20 text-right font-mono text-[11px] text-ink-3 sm:block"
          title={row.createdAt.toISOString()}
        >
          {row.pr?.number ? `#${row.pr.number}` : ago(row.finishedAt ?? row.createdAt)}
        </span>
      </Link>
    </li>
  );
}
