"use client";

import { useTheme } from "fumadocs-ui/provider/base";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * `?theme=dark` or `?theme=light` on a kit page shows it in that theme (captures and shared links).
 * The viewer's own choice comes back when they leave the page (review round 2: a link must not
 * change someone's preference).
 */
export function ThemeFromUrl() {
  const theme = useSearchParams().get("theme");
  const { theme: chosen, setTheme } = useTheme();
  // Only the URL decides; the viewer's choice is read once, when the page opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the choice is restored, not followed
  useEffect(() => {
    if (theme !== "dark" && theme !== "light") return;
    const before = chosen;
    setTheme(theme);
    return () => {
      if (before) setTheme(before);
    };
  }, [theme, setTheme]);
  return null;
}
