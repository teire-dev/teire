"use client";

import { Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { GraphStrip } from "@/components/flow/mini-flow";
import { TileSquare } from "@/components/flow/tile";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { planTile } from "@/lib/estate";
import type { FlowGraph, FlowState } from "@/lib/flow/model";
import { subjectMark } from "@/lib/marks";
import { cn } from "@/lib/utils";
import type { ChangeReach } from "@/lib/workspace";
import { reachState } from "./change-fan";
import { runAction } from "./run-action";

/** One repository's path, as every finding row draws it: change → your code → fix → PR (C2). */
function pathOf(r: ChangeReach): FlowGraph {
  const fix: FlowState = reachState(r);
  const out: FlowState = r.plan.kind === "open" ? "done" : fix === "skipped" ? "skipped" : "pending";
  const tiles = [
    {
      id: "c",
      entity: "change" as const,
      state: "done" as const,
      label: "Change",
      brand: subjectMark(r.groupKey),
    },
    {
      id: "k",
      entity: "code" as const,
      state: "done" as const,
      label: `${r.sites} call site${r.sites === 1 ? "" : "s"}`,
    },
    { id: "f", entity: "fix" as const, state: fix, label: "Fix" },
    {
      id: "o",
      entity: "outcome" as const,
      state: out,
      label: r.plan.kind === "open" ? `PR #${r.plan.number}` : "Pull request",
    },
  ];
  return {
    tiles,
    links: tiles.slice(1).map((t, i) => ({ from: tiles[i]?.id as string, to: t.id, state: t.state })),
  };
}

/** The worker's receipt, "N of M started: repo: what happened; …", as one result per repository. */
function resultsOf(result: string | null) {
  const out = new Map<string, string>();
  const body = result?.split(" started: ")[1] ?? "";
  for (const part of body.split("; ")) {
    const at = part.indexOf(": ");
    if (at > 0) out.set(part.slice(0, at), part.slice(at + 2));
  }
  return out;
}

const resultTone = (said: string) =>
  /queued|running|started|live/.test(said)
    ? "bg-proven-soft text-proven"
    : /write access|no longer|not in/.test(said)
      ? "bg-broke-soft text-broke"
      : "bg-sunken text-ink-2";

/**
 * Fix in all (plan revision 3.3, U3; Sourcegraph's preview before a batch): each repository the
 * change reaches, with what Fix now does there, shown before anything starts; Confirm sends one Fix
 * now per repository that would start a run, each checked by the worker for write access and fix
 * mode, all in one action whose result is a receipt per repository.
 */
export function FixInAll({
  title,
  changeId,
  installationId,
  reaches,
}: {
  title: string;
  changeId: string;
  installationId: number;
  reaches: ChangeReach[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  // After Confirm the dialog stays: each repository's result as a chip, refusals included (C2).
  const [results, setResults] = useState<Map<string, string> | null>(null);
  // A refusal of the whole action ("You no longer have access…") has no per-repository lines.
  const [said, setSaid] = useState<string | null>(null);
  const starts = reaches.filter((r) => r.plan.kind === "run");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setResults(null);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant={starts.length ? "default" : "outline"} disabled={!starts.length}>
          <Wrench data-icon="inline-start" aria-hidden />
          Fix in all{starts.length ? ` (${starts.length})` : ""}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fix in all</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        {/* Each repository as what Fix now does there: a state tile and its words, nothing to read twice. */}
        <ul className="flex max-h-80 flex-col divide-y divide-rule overflow-auto rounded-lg ring-1 ring-rule ring-inset">
          {reaches.map((r) => {
            const t = planTile(r);
            return (
              <li key={`${r.repo}-${r.groupKey}`} className="flex items-center gap-3 px-3 py-2">
                <TileSquare tile={t} size="sm" className="!size-8" />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{r.repo.split("/")[1]}</span>
                <GraphStrip graph={pathOf(r)} className="hidden shrink-0 sm:inline-flex" />
                {results?.has(r.repo.split("/")[1] ?? "") ? (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px]",
                      resultTone(results.get(r.repo.split("/")[1] ?? "") ?? ""),
                    )}
                  >
                    {results.get(r.repo.split("/")[1] ?? "")}
                  </span>
                ) : results ? null : (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px]",
                      r.plan.kind === "run"
                        ? r.plan.waits
                          ? "bg-attention-soft text-attention"
                          : "bg-signal-soft text-signal"
                        : "bg-sunken text-ink-3",
                    )}
                    title={
                      r.plan.kind === "off" ? r.plan.why : r.plan.kind === "run" ? r.plan.waits : undefined
                    }
                  >
                    {r.plan.kind === "run"
                      ? r.plan.waits
                        ? "waits for the PR limit"
                        : "starts a run"
                      : r.plan.kind === "open"
                        ? `#${r.plan.number} open`
                        : r.plan.kind === "running"
                          ? "running"
                          : r.plan.kind === "paused"
                            ? "paused"
                            : "fixes off"}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {results && !results.size && said ? (
          <p className="rounded-md bg-broke-soft px-3 py-2 text-sm text-broke">{said}</p>
        ) : (
          <p className="font-mono text-[11px] text-ink-3">Write access is checked at start</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {results ? "Close" : "Cancel"}
          </Button>
          {results ? null : (
            <Button
              disabled={busy || !starts.length}
              onClick={async () => {
                setBusy(true);
                try {
                  // One action: the worker starts each repository's run and answers with a receipt per repository.
                  await runAction(
                    {
                      kind: "fix-in-all",
                      params: { changeId, title, repos: starts.map((r) => r.repo) },
                      installationId,
                    },
                    {
                      onSettled: (state) => {
                        setResults(resultsOf(state.result));
                        setSaid(state.result);
                        router.refresh();
                      },
                    },
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Starting…" : `Start ${starts.length} run${starts.length === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
