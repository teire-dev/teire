import type { Metadata } from "next";
import { Suspense } from "react";
import { ThemeFromUrl } from "@/components/teire/theme-from-url";

export const metadata: Metadata = {
  title: { default: "Kit", template: "%s · Kit · Teire" },
  robots: { index: false, follow: false },
};

/**
 * U0's kit (plan revision 3.3): the primitives and three compositions on real fork data, for the
 * people building Teire. Every page checks access inside its own Suspense boundary (`requireKit`).
 */
export default function KitLayout({ children }: LayoutProps<"/kit">) {
  return (
    <div className="flex min-h-svh flex-1 flex-col bg-canvas text-ink">
      <Suspense>
        <ThemeFromUrl />
      </Suspense>
      {children}
    </div>
  );
}
