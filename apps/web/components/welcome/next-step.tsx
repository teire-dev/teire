"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { StaticFlow } from "@/components/flow/static-flow";
import { TEIRE } from "@/lib/brands";

/**
 * After onboarding, the Overview's "next step" (plan revision 3.4, V4): what happens now as three
 * tiles (on → scanning → PRs by your fix mode), shown once and dismissible.
 */
export function NextStep() {
  const [repos, setRepos] = useState<number | null>(null);
  useEffect(() => {
    try {
      const done = JSON.parse(localStorage.getItem("teire-welcome-done") ?? "null") as {
        repos?: number;
      } | null;
      if (done) setRepos(done.repos ?? 0);
    } catch {}
  }, []);
  if (repos === null) return null;
  const dismiss = () => {
    try {
      localStorage.removeItem("teire-welcome-done");
    } catch {}
    setRepos(null);
  };
  return (
    <aside className="flex items-center gap-4 rounded-xl bg-sheet px-4 py-3 shadow-card">
      <StaticFlow
        size="sm"
        className="min-w-0 flex-1 md:!pb-8"
        label="What happens now"
        graph={{
          tiles: [
            { id: "on", entity: "fix", state: "done", label: "Teire is on", brand: TEIRE },
            {
              id: "scan",
              entity: "repository",
              state: "live",
              label: repos ? `Scanning ${repos} repo${repos === 1 ? "" : "s"}` : "Scanning",
            },
            {
              id: "prs",
              entity: "outcome",
              state: "pending",
              label: "PRs by your fix mode",
              href: "/app/runs?show=active",
            },
          ],
          links: [
            { from: "on", to: "scan", state: "live" },
            { from: "scan", to: "prs", state: "pending" },
          ],
        }}
      />
      <kbd className="hidden shrink-0 rounded-md bg-sunken px-2 py-1 font-mono text-[11px] text-ink-2 md:inline">
        ⌘I asks Teire
      </kbd>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-ink-3 hover:text-ink"
      >
        <X className="size-4" aria-hidden />
      </button>
    </aside>
  );
}
