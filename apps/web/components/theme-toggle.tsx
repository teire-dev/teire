"use client";

import { useTheme } from "fumadocs-ui/provider/base";
import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const NEXT = { system: "light", light: "dark", dark: "system" } as const;
const ICON = { system: Monitor, light: Sun, dark: Moon } as const;

/** Cycles system → light → dark; the icon shows the current choice. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = (mounted && theme && theme in NEXT ? theme : "system") as keyof typeof NEXT;
  const Icon = ICON[current];
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      aria-label={`Theme: ${current}. Switch to ${NEXT[current]}`}
      onClick={() => setTheme(NEXT[current])}
    >
      <Icon />
    </Button>
  );
}
