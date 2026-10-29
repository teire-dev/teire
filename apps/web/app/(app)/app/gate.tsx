import { ArrowUpRight, Eye, GitPullRequest } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ConnectDiagram } from "@/components/brand/beam";
import { BrandLogo } from "@/components/brand-logo";
import { GithubMark } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ECOSYSTEMS } from "@/lib/brands";
import { INSTALL_URL } from "@/lib/site";

/**
 * Signed out (plan revision 3.4, V4): the sign-in split, which comes back here once GitHub says who
 * this is. A component so every app page keeps one line for it.
 */
export function SignInCard({ next }: { next: string }): never {
  redirect(`/signin?next=${encodeURIComponent(next)}`);
}

/**
 * Nothing installed yet (plan revision 3.4, V4): GitHub → Teire → your repositories as a beam, the two
 * things Teire does with access as chips, Install on GitHub; what Teire will and won't do lives on
 * /trust, one link away.
 */
export function InstallCard() {
  return (
    <section className="mx-auto grid w-full max-w-5xl overflow-hidden rounded-card bg-sheet shadow-card md:grid-cols-[1fr_1.1fr]">
      <div className="flex flex-col items-start justify-center gap-5 p-8">
        <h1 className="display text-4xl text-ink">Install Teire</h1>
        <ul className="flex flex-wrap gap-2 text-xs">
          <li className="flex items-center gap-1.5 rounded-full bg-sunken px-3 py-1 text-ink-2">
            <Eye className="size-3.5" aria-hidden />
            reads your code
          </li>
          <li className="flex items-center gap-1.5 rounded-full bg-sunken px-3 py-1 text-ink-2">
            <GitPullRequest className="size-3.5" aria-hidden />
            opens pull requests
          </li>
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="cta" size="xl" shape="pill">
            <a href={INSTALL_URL}>
              <GithubMark className="size-4" />
              Install on GitHub
            </a>
          </Button>
          <Button asChild variant="ghost" size="xl" shape="pill">
            <Link href="/scan">Scan a public repo</Link>
          </Button>
        </div>
        <Link href="/trust" className="flex items-center gap-1 text-xs text-ink-3 hover:text-ink">
          What Teire will and won&apos;t do <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      </div>
      <aside className="relative flex flex-col justify-center overflow-hidden bg-hero p-8 text-hero-ink">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_60%_at_70%_20%,var(--hero-2),transparent)] opacity-70"
        />
        <ConnectDiagram
          className="relative px-2"
          repos={[ECOSYSTEMS.npm, ECOSYSTEMS.pypi, ECOSYSTEMS.go].filter(Boolean).map((e) => ({
            key: e?.label ?? "",
            node: (
              <BrandLogo light={e?.light ?? ""} dark={e?.dark} alt={e?.label ?? ""} className="h-5 max-w-7" />
            ),
          }))}
        />
      </aside>
    </section>
  );
}
