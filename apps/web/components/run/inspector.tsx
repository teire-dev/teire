"use client";

import { ArrowRight, ExternalLink } from "lucide-react";
import { TileSquare } from "@/components/flow/tile";
import { Markdown } from "@/components/markdown";
import { DiffView } from "@/components/run/diff-view";
import { Ledger, type LedgerCheck } from "@/components/teire/ledger";
import { EvidenceChip } from "@/components/teire/status-chip";
import type { ActivityRow } from "@/lib/activity";
import { FLOW_STATE_LABEL, type FlowEntity, type FlowTile, TILE_OF_STEP } from "@/lib/flow/model";
import type { RunSheetData } from "@/lib/run-sheet";
import { cn } from "@/lib/utils";
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

      {tile.entity === "change" ? (
        data.context.length ? (
          <ul className="flex flex-col gap-3">
            {data.context.flatMap(([group, items]) =>
              items.slice(0, 6).map((item, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two sources can share a title; order is stable
                <li key={`${group}-${item.title}-${i}`} className="rounded-card bg-sunken p-3">
                  <p className="eyebrow mb-1">{group}</p>
                  {item.url?.startsWith("https://") ? (
                    <a
                      href={item.url}
                      rel="noreferrer noopener"
                      target="_blank"
                      className="text-[13px] font-medium text-ink hover:underline"
                    >
                      {item.title}
                    </a>
                  ) : (
                    <p className="text-[13px] font-medium text-ink">{item.title}</p>
                  )}
                  {item.quote ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer font-mono text-[11px] text-ink-3">
                        What it said
                      </summary>
                      <blockquote className="mt-1 max-h-48 overflow-auto border-l-2 border-rule pl-2 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2">
                        {item.quote}
                      </blockquote>
                    </details>
                  ) : null}
                </li>
              )),
            )}
          </ul>
        ) : (
          <p className="text-sm text-ink-3">Recorded upstream.</p>
        )
      ) : null}

      {tile.entity === "repository" ? (
        <a
          href={`https://github.com/${repo.fullName}`}
          className="inline-flex items-center gap-1.5 text-sm text-link hover:underline"
        >
          {repo.fullName}
          <ExternalLink className="size-3.5" />
        </a>
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
          {run.kind === "dry_run" && sheet.preview?.body ? (
            <article className="max-h-[480px] overflow-auto rounded-card bg-sunken p-4">
              {sheet.preview.title ? (
                <h3 className="mb-3 text-[15px] font-medium">{sheet.preview.title}</h3>
              ) : null}
              <Markdown>{sheet.preview.body}</Markdown>
            </article>
          ) : null}
          <div className="overflow-hidden rounded-card bg-sunken">
            <Closing sheet={sheet} />
          </div>
        </div>
      ) : null}

      {own.length ? (
        <ol className="divide-y divide-rule overflow-hidden rounded-card bg-sheet shadow-card">
          {own.map((row, i) => (
            <ActivityItem key={row.key} row={row} open={row.state === "live" || i === own.length - 1} />
          ))}
        </ol>
      ) : tile.entity !== "change" &&
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
