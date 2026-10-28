"use client";

import type { FixMode } from "@teire/engine/config";
import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { runActions } from "./run-action";

const CHOICES: [FixMode | null, string][] = [
  ["auto", "Automatic"],
  ["ask", "Ask first"],
  ["off", "Off"],
  [null, "Use the installation's default"],
];

/**
 * "Set fix mode…" for every repository the list shows (Cursor Bugbot's enable all / disable all): one
 * action per repository, each with its own outcome; a repository whose `teire.yml` sets the mode says
 * so and keeps it.
 */
export function BulkFixMode({ repos }: { repos: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={busy || !repos.length}>
          Set fix mode…
          <ChevronDown data-icon="inline-end" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="eyebrow">
          For the {repos.length} repositor{repos.length === 1 ? "y" : "ies"} shown
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {CHOICES.map(([mode, label]) => (
          <DropdownMenuItem
            key={label}
            onSelect={async () => {
              setBusy(true);
              try {
                await runActions(
                  repos.map((repo) => ({ kind: "set-fix-mode", params: { mode }, repo })),
                  mode ? `Fix mode ${label}` : "Installation default",
                );
                router.refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
