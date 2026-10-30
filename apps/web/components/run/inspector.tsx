"use client";

import { ArrowRight, ExternalLink } from "lucide-react";
import { TileSquare } from "@/components/flow/tile";
import { DiffView } from "@/components/run/diff-view";
import { Ledger, type LedgerCheck } from "@/components/teire/ledger";
import { EvidenceChip } from "@/components/teire/status-chip";
import type { ActivityRow } from "@/lib/activity";
import { FLOW_STATE_LABEL, type FlowEntity, type FlowTile, TILE_OF_STEP } from "@/lib/flow/model";
import { postOf } from "@/lib/run-evidence";
import type { RunSheetData } from "@/lib/run-sheet";
import { cn } from "@/lib/utils";
import { Commits, PostView, Upstream, YourCode } from "./evidence";
import { ActivityItem, Closing, type ContextItem } from "./sheet-parts";

/**
 * A tile's evidence (plan revision 3.4, V3; n8n's node panel): what that step did, in its own words
 * and figures — the step rows with their commands for the updater and the sandbox, the diff for the
 * fix, the before/after ledger for the checks, the quotes for the change, the PR for the outcome.
 * Everything the long proof sheet showed is here, one tile at a time.
 */
export interface InspectorData {
  sheet: RunSheetData;
  rows: ActivityRow[];
  baseline: LedgerCheck[];
  after: LedgerCheck[];
  notCovered: string[];
  liveLedger: boolean;
  context: [string, ContextItem[]][];
}

const rowsFor = (rows: ActivityRow[], entity: FlowEntity) =>
  rows.filter((r) => (TILE_OF_STEP[r.step] ?? (r.step === "queue" ? "change" : null)) === entity);

export function Inspector({
  tile,
  data,
  className,
}: {
  tile: FlowTile;
  data: InspectorData;
  className?: string;
}) {
  const { sheet, rows } = data;
  const { run, artifact, verification, repo } = sheet;
  const own = rowsFor(rows, tile.entity);
  // Attempts: a new one starts when a row's title comes round again; the last is shown, the rest fold.
  const attempts: (typeof own)[] = [];
  for (const row of own) {
    const current = attempts.at(-1);
    if (!current || current.some((r) => r.title === row.title)) attempts.push([row]);
    else current.push(row);
  }
  const latest = attempts.at(-1) ?? [];
  const post = tile.entity === "outcome" ? postOf(sheet.events, artifact) : null;
  const earlier = attempts.slice(0, -1).flat();
  return (
    <section aria-label={`${tile.label}: evidence`} className={cn("flex min-w-0 flex-col gap-4", className)}>
      <header className="flex items-center gap-3">
        <TileSquare tile={tile} size="sm" />
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-medium text-ink">{tile.label}</h2>
          <p className="font-mono text-[11px] text-ink-3">
            {FLOW_STATE_LABEL[tile.state]}
            {tile.meta ? ` · ${tile.meta}` : ""}
          </p>
        </div>
        {tile.entity === "check" && run.evidenceKind ? (
          <span className="ml-auto">
            <EvidenceChip kind={run.evidenceKind} />
          </span>
        ) : null}
      </header>

      {tile.entity === "change" ? <Upstream sheet={sheet} context={data.context} /> : null}

      {tile.entity === "code" ? <YourCode sheet={sheet} /> : null}

      {tile.entity === "repository" ? (
        <div className="flex flex-col gap-3">
          <a
            href={`https://github.com/${repo.fullName}`}
            className="inline-flex items-center gap-1.5 text-sm text-link hover:underline"
          >
            {repo.fullName}
            <ExternalLink className="size-3.5" />
          </a>
          <Commits sheet={sheet} />
        </div>
      ) : null}

      {tile.entity === "check" ? (
        data.baseline.length || data.after.length ? (
          <Ledger
            baseline={data.baseline}
            after={data.after}
            evidence={run.evidenceKind}
            verdict={verification?.reasons?.[0] ?? ""}
            notCovered={data.notCovered}
            live={data.liveLedger}
          />
        ) : (
          <p className="text-sm text-ink-3">No checks have run yet.</p>
        )
      ) : null}
      {tile.entity === "check" && verification?.others?.length ? (
        <div className="flex flex-col gap-3">
          <p className="eyebrow">Other projects it touched</p>
          {verification.others.map((o) => (
            <div key={`${o.ecosystem}:${o.root}`} className="flex flex-col gap-2">
              <span className="font-mono text-xs text-ink">
                {o.root === "." ? "(root)" : o.root} · {o.ecosystem}
              </span>
              <Ledger
                baseline={o.baseline as LedgerCheck[]}
                after={o.after as LedgerCheck[]}
                evidence={o.evidence}
                verdict={o.reasons[0] ?? ""}
                notCovered={o.reasons}
              />
            </div>
          ))}
        </div>
      ) : null}

      {tile.entity === "fix" && run.diff ? (
        <div className="max-h-[420px] overflow-auto rounded-card bg-sunken p-3">
          <DiffView patch={run.diff} />
        </div>
      ) : null}

      {tile.entity === "outcome" ? (
        <div className="flex flex-col gap-3">
          {artifact?.url ? (
            <a
              href={artifact.url}
              className="group flex items-center gap-3 rounded-card bg-sunken p-3 hover:bg-hover"
            >
              <span className="text-[14px] font-medium">
                {artifact.kind === "issue" ? "Issue" : "Pull request"} #{artifact.number}
              </span>
              <span className="font-mono text-[11px] text-ink-3">{artifact.state}</span>
              <ArrowRight className="ml-auto size-4 text-ink-3 group-hover:text-ink" />
            </a>
          ) : null}
          {post ? <PostView post={post} compact /> : null}
          <div className="overflow-hidden rounded-card bg-sunken">
            <Closing sheet={sheet} />
          </div>
        </div>
      ) : null}

      {own.length ? (
        <>
          {/* A step the agent repeated (checks, evidence per attempt): the last attempt open, the
              earlier ones folded, so identical rows never stack up unexplained (V7 final review). */}
          <ol className="divide-y divide-rule overflow-hidden rounded-card bg-sheet shadow-card">
            {latest.map((row, i) => (
              <ActivityItem key={row.key} row={row} open={row.state === "live" || i === latest.length - 1} />
            ))}
          </ol>
          {earlier.length ? (
            <details className="group/earlier">
              <summary className="w-fit cursor-pointer list-none font-mono text-[11px] text-ink-3 hover:text-ink [&::-webkit-details-marker]:hidden">
                Earlier attempts ({attempts.length - 1}) ›
              </summary>
              <ol className="mt-2 divide-y divide-rule overflow-hidden rounded-card bg-sheet shadow-card">
                {earlier.map((row) => (
                  <ActivityItem key={row.key} row={row} open={false} />
                ))}
              </ol>
            </details>
          ) : null}
        </>
      ) : tile.entity !== "change" &&
        tile.entity !== "code" &&
        tile.entity !== "repository" &&
        tile.entity !== "outcome" &&
        tile.entity !== "check" ? (
        <p className="text-sm text-ink-3">
          {tile.state === "pending" ? "Not reached yet." : "Nothing recorded for this step."}
        </p>
      ) : null}
    </section>
  );
}
