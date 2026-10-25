"use client";

import { ThemeProvider as NextThemes } from "next-themes";
import type { ComponentProps } from "react";

/** Light, dark or the system's choice, as a `dark` class on <html> (the tokens' dark variant). */
export function ThemeProvider(props: ComponentProps<typeof NextThemes>) {
  return (
    <NextThemes attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange {...props} />
  );
}
