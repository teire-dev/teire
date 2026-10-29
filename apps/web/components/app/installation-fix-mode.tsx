"use client";

import type { FixMode } from "@teire/engine/config";
import { Check, Hand, PowerOff, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { FIX_MODES } from "@/lib/fix-mode-options";
import { cn } from "@/lib/utils";
import { runAction } from "./run-action";

const ICON: Record<FixMode, typeof Zap> = { auto: Zap, ask: Hand, off: PowerOff };

/**
 * The installation's default fix mode and its security setting (D118, D126), as three cards like
 * onboarding's: every repository that sets none of its own follows it. Only an org admin (or the
 * account owner) can change it; the worker checks that on GitHub and says so when it refuses.
 */
export function InstallationFixMode({
  installationId,
  mode,
  security,
}: {
  installationId: number;
  mode: FixMode;
  security: "auto" | "ask";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<FixMode | "security" | null>(null);
  const set = async (next: { mode: FixMode; security: "auto" | "ask" }, what: FixMode | "security") => {
    setBusy(what);
    try {
      await runAction(
        { kind: "set-installation-fix-mode", params: next, installationId },
        { onSettled: () => router.refresh() },
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Default fix mode" className="grid gap-2 sm:grid-cols-3">
        {FIX_MODES.map((m) => {
          const on = mode === m.value;
          const Icon = ICON[m.value];
          return (
            // biome-ignore lint/a11y/useSemanticElements: a card radio (icon, name, caption); the group carries radiogroup semantics
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={busy !== null}
              onClick={() => (on ? null : void set({ mode: m.value, security }, m.value))}
              className={cn(
                "flex items-start gap-3 rounded-xl p-3.5 text-left transition-shadow disabled:opacity-70",
                on
                  ? "bg-sheet shadow-[0_0_0_2px_var(--ink)]"
                  : "bg-sheet shadow-card hover:shadow-card-hover",
              )}
            >
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-[10px]",
                  on ? "bg-ink text-sheet" : "bg-sunken text-ink-2",
                )}
              >
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  {m.label}
                  {on ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : null}
                  {busy === m.value ? (
                    <span className="size-1.5 animate-live rounded-full bg-signal" />
                  ) : null}
                </span>
                <span className="text-xs text-ink-3">{m.said}</span>
              </span>
            </button>
          );
        })}
      </div>
      <label
        htmlFor="security-fixes"
        className="flex w-fit items-center gap-2.5 rounded-full bg-sheet py-1.5 pr-3.5 pl-2 text-sm text-ink-2 shadow-tile ring-1 ring-rule"
      >
        <Switch
          id="security-fixes"
          checked={security === "auto"}
          disabled={busy !== null || mode === "off"}
          onCheckedChange={(on) => void set({ mode, security: on ? "auto" : "ask" }, "security")}
        />
        Security fixes start on their own
      </label>
    </div>
  );
}
