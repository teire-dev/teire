"use client";

import { Check, Copy, Globe, Lock, Share2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Share a run (plan revision 3.3, U2, Factory's share dialog): its link with copy, and who can open
 * it: anyone for a public repository, people with access to the installation for a private one.
 */
export function ShareRun({
  runId,
  isPrivate,
  rerun,
}: {
  runId: string;
  isPrivate: boolean;
  /** The secondary action: run it again in the way this run allows (Factory's share dialog). */
  rerun?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? `/runs/${runId}` : `${window.location.origin}/runs/${runId}`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Share2 data-icon="inline-start" aria-hidden />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share this run</DialogTitle>
          <DialogDescription>
            Its proof sheet: what changed, what was fixed and what proves it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg bg-sunken p-1.5 pl-3 ring-1 ring-rule ring-inset">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">{url}</span>
          <Button
            size="sm"
            variant="outline"
            aria-label={copied ? "Copied" : "Copy the link"}
            onClick={() =>
              void navigator.clipboard.writeText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        </div>
        <p className="flex items-center gap-2 text-sm text-ink-2">
          {isPrivate ? (
            <Lock className="size-4 text-ink-3" aria-hidden />
          ) : (
            <Globe className="size-4 text-ink-3" aria-hidden />
          )}
          {isPrivate
            ? "People with access to this installation can open it."
            : "Anyone with the link can open it: the repository is public."}
        </p>
        {rerun ? <div className="flex justify-end border-t border-rule pt-3">{rerun}</div> : null}
      </DialogContent>
    </Dialog>
  );
}
