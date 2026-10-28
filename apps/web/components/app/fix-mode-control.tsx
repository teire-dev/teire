"use client";

import type { FixMode, FixModeOrigin } from "@teire/engine/config";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { runAction } from "./run-action";

const MODES: [FixMode, string][] = [
  ["auto", "Automatic"],
  ["ask", "Ask first"],
  ["off", "Off"],
];

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
}: {
  repo: string;
  mode: FixMode;
  origin: FixModeOrigin;
  file: string | null;
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
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="eyebrow">Fixes</span>
      <ToggleGroup
        type="single"
        value={pending ?? mode}
        onValueChange={(v) => v && v !== mode && void set(v as FixMode)}
        disabled={locked || pending !== null}
        aria-label="Fix mode"
        className="rounded-lg bg-sunken p-0.5 ring-1 ring-rule ring-inset"
      >
        {MODES.map(([value, label]) => (
          <ToggleGroupItem
            key={value}
            value={value}
            className="h-7 rounded-md px-3 text-xs text-ink-2 data-[state=on]:bg-sheet data-[state=on]:text-ink data-[state=on]:shadow-card"
          >
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
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
