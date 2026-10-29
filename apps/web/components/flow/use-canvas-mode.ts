"use client";

import { useTheme } from "fumadocs-ui/provider/base";
import { useEffect, useState } from "react";

/**
 * React Flow's own light/dark class, matched to the app's theme without a hydration mismatch (V7
 * walk): the server can't know the theme, so the first render is light everywhere and the resolved
 * theme takes over once mounted.
 */
export function useCanvasMode(): "light" | "dark" {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && resolvedTheme === "dark" ? "dark" : "light";
}
