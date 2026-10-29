"use client";

import type { FixMode } from "@teire/engine/config";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { FixModePicker } from "./fix-mode-picker";
import { runAction } from "./run-action";

/**
 * The installation's default fix mode and its security setting (D118, D126): every repository that
 * sets none of its own follows it. Only an org admin (or the account owner) can change it; the worker
 * checks that on GitHub and says so when it refuses.
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
  const [busy, setBusy] = useState(false);
  const set = async (next: { mode: FixMode; security: "auto" | "ask" }) => {
    setBusy(true);
    try {
      await runAction(
        { kind: "set-installation-fix-mode", params: next, installationId },
        { onSettled: () => router.refresh() },
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="flex items-center gap-3">
        <span className="eyebrow">Default</span>
        <FixModePicker
          value={mode}
          disabled={busy}
          onChange={(v) => void set({ mode: v, security })}
          label="Default fix mode"
        />
      </div>
      <div className="flex items-center gap-2 text-sm text-ink-2">
        <Switch
          checked={security === "auto"}
          disabled={busy || mode === "off"}
          onCheckedChange={(on) => void set({ mode, security: on ? "auto" : "ask" })}
          aria-label="Security fixes start on their own"
        />
        <span aria-hidden>Security fixes start on their own</span>
      </div>
    </div>
  );
}
