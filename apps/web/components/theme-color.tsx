"use client";

import { useTheme } from "fumadocs-ui/provider/base";
import { useEffect } from "react";
import { THEME_COLOR } from "@/lib/theme-color";

/**
 * Keeps the browser chrome on the site's theme, not the device's: the viewport's `theme-color` tags
 * follow `prefers-color-scheme`, but the site defaults to light and a person can pick either. Once
 * the theme resolves, every tag (one per media query) takes its colour.
 */
export function ThemeColor() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;
    for (const tag of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
      tag.content = THEME_COLOR[resolvedTheme];
  }, [resolvedTheme]);
  return null;
}
