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
    "Teire finds the lines a package, API or model change breaks, and a Nemotron coding agent on Nebius Token Factory fixes what a plain swap can't. Your own tests run before and after, and a pull request shows the proof.",
};

/**
 * The one provider for the app and the docs: Fumadocs' RootProvider carries next-themes (the
 * `dark` class the tokens key on) and the docs' search. The site's header and footer live in the
 * (site) group; /docs has its own top bar. Light is the default (plan revision 3.3: light-first, an
 * equal dark mode); a person's own choice in the theme toggle is kept.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        <RootProvider
          theme={{
            attribute: "class",
            defaultTheme: "light",
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
