"use client";

import { Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
import { cn } from "@/lib/utils";
import type { ChangeReach } from "@/lib/workspace";
import { runAction } from "./run-action";

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
  const starts = reaches.filter((r) => r.plan.kind === "run");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px]",
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
              </li>
            );
          })}
        </ul>
        <p className="font-mono text-[11px] text-ink-3">needs write access · checked on GitHub</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || !starts.length}
            onClick={async () => {
              setBusy(true);
              try {
                // One action: the worker starts each repository's run and answers with a receipt per repository.
                await runAction({
                  kind: "fix-in-all",
                  params: { changeId, title, repos: starts.map((r) => r.repo) },
                  installationId,
                });
                setOpen(false);
                router.refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            Start {starts.length} run{starts.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
