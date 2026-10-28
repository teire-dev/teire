"use client";

import { useTheme } from "fumadocs-ui/provider/base";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

/** `?theme=dark` or `?theme=light` on a kit page sets the theme (captures and shared links). */
export function ThemeFromUrl() {
  const theme = useSearchParams().get("theme");
  const { setTheme } = useTheme();
  useEffect(() => {
    if (theme === "dark" || theme === "light") setTheme(theme);
  }, [theme, setTheme]);
  return null;
}
