"use client";

import type { ActionKind } from "@teire/engine/actions";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { runAction } from "./run-action";

/**
 * A button that asks for an action and shows its real outcome in a toast (U1, D121); the page
 * refreshes once the worker has answered. Busy while the action is open, so a second click can't ask
 * twice.
 */
export function ActionButton({
  kind,
  params = {},
  repo,
  installationId,
  children,
  variant = "outline",
  size = "sm",
  disabled,
  title,
}: {
  kind: ActionKind;
  params?: Record<string, unknown>;
  repo?: string;
  installationId?: number;
  children: React.ReactNode;
  variant?: "outline" | "default" | "ghost";
  size?: "sm" | "default";
  disabled?: boolean;
  title?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={busy || disabled}
      title={title}
      onClick={async () => {
        setBusy(true);
        try {
          await runAction(
            { kind, params, ...(repo ? { repo } : {}), ...(installationId ? { installationId } : {}) },
            { onSettled: () => router.refresh() },
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : null}
      {children}
    </Button>
  );
}
