"use client";

import { Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
        <ul className="flex max-h-72 flex-col divide-y divide-rule overflow-auto rounded-lg ring-1 ring-rule ring-inset">
          {reaches.map((r) => (
            <li
              key={`${r.repo}-${r.groupKey}`}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate font-mono text-xs text-ink">{r.repo}</span>
              <span
                className={
                  r.plan.kind === "run"
                    ? "text-xs text-signal"
                    : r.plan.kind === "open" || r.plan.kind === "running"
                      ? "text-xs text-ink-2"
                      : "text-xs text-ink-3"
                }
              >
                {r.plan.kind === "run"
                  ? (r.plan.waits ?? "starts a run")
                  : r.plan.kind === "open"
                    ? `#${r.plan.number} is open`
                    : r.plan.kind === "running"
                      ? "a run is already going"
                      : r.plan.kind === "paused"
                        ? "Teire is paused here"
                        : `fixes off (${r.plan.why})`}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-ink-3">
          Each run needs your write access on that repository; Teire checks it on GitHub when it starts.
        </p>
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
