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
 * Share a page (plan revision 3.3, U2 and U5, Factory's share dialog): its link with copy, and who can
 * open it. Runs and public scan reports both use it.
 */
export function ShareLink({
  path,
  title,
  description,
  isPrivate,
  label = "Share",
  secondary,
}: {
  path: string;
  title: string;
  description: string;
  isPrivate: boolean;
  label?: string;
  /** The secondary action (Factory's share dialog): run it again, install. */
  secondary?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? path : `${window.location.origin}${path}`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Share2 data-icon="inline-start" aria-hidden />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
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
        {secondary ? <div className="flex justify-end border-t border-rule pt-3">{secondary}</div> : null}
      </DialogContent>
    </Dialog>
  );
}

/** Share a run: its proof sheet, with Re-run as the secondary action. */
export function ShareRun({
  runId,
  isPrivate,
  rerun,
}: {
  runId: string;
  isPrivate: boolean;
  rerun?: ReactNode;
}) {
  return (
    <ShareLink
      path={`/runs/${runId}`}
      title="Share this run"
      description="Its proof sheet: what changed, what was fixed and what proves it."
      isPrivate={isPrivate}
      secondary={rerun}
    />
  );
}
