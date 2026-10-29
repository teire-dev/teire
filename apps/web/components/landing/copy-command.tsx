"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** A command chip with copy: the icon becomes a check for a moment (Factory's share pattern). */
export function CopyCommand({ command, tone = "light" }: { command: string; tone?: "light" | "hero" }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(command).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      className={cn(
        "group inline-flex items-center gap-3 rounded-full py-1.5 pr-2 pl-4 font-mono text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-signal",
        tone === "hero"
          ? "bg-white/6 text-hero-ink-2 shadow-[inset_0_0_0_1px_var(--hero-rule)] hover:text-hero-ink"
          : "bg-sunken text-ink-2 hover:text-ink",
      )}
      aria-label={done ? "Copied" : `Copy ${command}`}
    >
      <span>
        <span className={tone === "hero" ? "text-hero-ink-2/60" : "text-ink-3"}>$ </span>
        {command}
      </span>
      <span
        className={cn(
          "flex size-7 items-center justify-center rounded-full",
          tone === "hero" ? "bg-white/8" : "bg-sheet shadow-card",
        )}
      >
        {done ? <Check className="size-3.5 text-proven" /> : <Copy className="size-3.5" />}
      </span>
    </button>
  );
}
