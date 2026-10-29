"use client";

import type { FixMode } from "@teire/engine/config";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FIX_MODES } from "@/lib/fix-mode-options";
import { cn } from "@/lib/utils";

/** Automatic · Ask first · Off as one segmented control: a repository's, the installation's default. */
export function FixModePicker({
  value,
  onChange,
  disabled,
  label,
  short,
  className,
}: {
  value: FixMode;
  onChange: (mode: FixMode) => void;
  disabled?: boolean;
  /** What the control sets, for screen readers ("Fix mode", "Default fix mode"). */
  label: string;
  /** In a table row: Auto · Ask · Off, the full name on hover. */
  short?: boolean;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && v !== value && onChange(v as FixMode)}
      disabled={disabled}
      aria-label={label}
      className={cn("rounded-lg bg-sunken p-0.5 ring-1 ring-rule ring-inset", className)}
    >
      {FIX_MODES.map((m) => (
        <ToggleGroupItem
          key={m.value}
          value={m.value}
          title={short ? m.label : undefined}
          aria-label={m.label}
          className={cn(
            "h-7 rounded-md text-xs text-ink-2 data-[state=on]:bg-sheet data-[state=on]:text-ink data-[state=on]:shadow-card",
            short ? "px-2" : "px-3",
          )}
        >
          {short ? m.short : m.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
