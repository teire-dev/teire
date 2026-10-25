import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.BETTER_AUTH_URL ?? "https://teire.vercel.app"),
  title: {
    default: "Teire: when a package, API or model changes, Teire fixes your code",
    template: "%s · Teire",
  },
  description:
    "A Nemotron coding agent on Nebius Token Factory finds the lines a package, API or model change breaks, fixes them, runs your own tests before and after, and opens a pull request.",
};

/**
 * The one provider for the app and the docs: Fumadocs' RootProvider carries next-themes (the
 * `dark` class the tokens key on) and the docs' search. The site's header and footer live in the
 * (site) group; /docs has its own top bar.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <RootProvider
          theme={{
            attribute: "class",
            defaultTheme: "system",
            enableSystem: true,
            disableTransitionOnChange: true,
          }}
        >
          <TooltipProvider delayDuration={200}>
            {children}
            <Toaster />
          </TooltipProvider>
        </RootProvider>
      </body>
    </html>
  );
}
