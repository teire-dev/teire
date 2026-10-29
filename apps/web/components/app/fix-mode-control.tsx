"use client";

import type { FixMode, FixModeOrigin } from "@teire/engine/config";
import { Lock, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FixModePicker } from "./fix-mode-picker";
import { runAction } from "./run-action";

/**
 * A repository's fix mode (D118, D124): Automatic · Ask first · Off, always the effective mode and
 * where it was set. A file that sets it locks the control ("Set in .github/teire.yml"); a mode set
 * here can go back to the installation's default.
 */
export function FixModeControl({
  repo,
  mode,
  origin,
  file,
  compact,
}: {
  repo: string;
  mode: FixMode;
  origin: FixModeOrigin;
  file: string | null;
  /** In a table row: no label, and where the mode was set as an icon with its words on hover. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<FixMode | null>(null);
  const locked = origin === "repo-file";
  const set = async (next: FixMode | null) => {
    setPending(next ?? mode);
    try {
      await runAction(
        { kind: "set-fix-mode", params: { mode: next }, repo },
        { onSettled: () => router.refresh() },
      );
    } finally {
      setPending(null);
    }
  };
  const picker = (
    <FixModePicker
      value={pending ?? mode}
      onChange={(v) => void set(v)}
      disabled={locked || pending !== null}
      label={`Fix mode for ${repo}`}
      short={compact}
    />
  );
  if (compact)
    return (
      <div className="flex items-center gap-1.5">
        {picker}
        {locked ? (
          <Lock className="size-3.5 text-ink-3" aria-label={`Set in ${file}`}>
            <title>Set in {file}: change it there</title>
          </Lock>
        ) : origin === "dashboard" ? (
          <button
            type="button"
            onClick={() => void set(null)}
            disabled={pending !== null}
            title="Set here: go back to the installation's default"
            aria-label="Use the installation's default"
            className="rounded p-0.5 text-ink-3 hover:bg-hover hover:text-ink"
          >
            <RotateCcw className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="eyebrow">Fixes</span>
      {picker}
      <span className="font-mono text-[11px] text-ink-3">
        {locked ? (
          <>Set in {file} · change it there</>
        ) : origin === "dashboard" ? (
          <>
            set here ·{" "}
            <button
              type="button"
              className="entity-link"
              onClick={() => void set(null)}
              disabled={pending !== null}
            >
              use the default
            </button>
          </>
        ) : origin === "org-file" ? (
          <>from {file}</>
        ) : (
          "installation default"
        )}
      </span>
    </div>
  );
}
