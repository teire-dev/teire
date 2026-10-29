"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * After onboarding, the Overview's "next step" (plan revision 3.3, U5): what happens now and where to
 * watch it, shown once and dismissible.
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
    <aside className="flex items-start justify-between gap-4 rounded-xl bg-signal-soft px-4 py-3 text-sm text-ink">
      <p>
        <span className="font-medium">
          Teire is on{repos ? ` for ${repos} repositor${repos === 1 ? "y" : "ies"}` : ""}.
        </span>{" "}
        Each one is being scanned again; fixes start by your fix mode and show under{" "}
        <Link href="/app/runs?show=active" className="entity-link">
          Working now
        </Link>
        . Press <kbd className="rounded bg-sheet px-1 font-mono text-[11px]">⌘I</kbd> to ask Teire what needs
        you.
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="rounded p-1 text-ink-3 hover:text-ink"
      >
        <X className="size-4" aria-hidden />
      </button>
    </aside>
  );
}
