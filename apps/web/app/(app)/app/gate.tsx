import { ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { GithubMark } from "@/components/icons";
import { SignInButton } from "@/components/sign-in-button";
import { Button } from "@/components/ui/button";
import { INSTALL_URL } from "@/lib/site";

/** Signed out: one GitHub button and what it is for (C1). */
export function SignInCard({ next }: { next: string }) {
  return (
    <section className="mx-auto flex w-full max-w-md flex-col items-start gap-4 rounded-lg bg-card p-6 shadow-card">
      <h1 className="text-xl font-semibold tracking-tight">Sign in to see your repositories</h1>
      <p className="text-sm text-muted-foreground">
        Teire uses your GitHub sign-in only to know which installations you can see. It does not ask your
        account for access to any repository.
      </p>
      <SignInButton next={next} label="Sign in with GitHub" />
    </section>
  );
}

const WILL = [
  "Read your manifests, lockfiles and code to find what each change reaches",
  "Push one branch per fix and open a pull request with its evidence",
  "Keep one Dashboard issue per repository, and answer @teire commands",
];
const WONT = [
  "Push to your default branch or merge anything",
  "Run your code anywhere but a sandbox, with the network off for your checks",
  "Send your code to any model but NVIDIA Nemotron on Nebius Token Factory",
];

/** No installation yet: the trust card, then install or scan (design ledger: Linear 8058e1c0). */
export function InstallCard() {
  return (
    <section className="grid gap-px overflow-hidden rounded-lg bg-border shadow-card md:grid-cols-[1.2fr_1fr]">
      <div className="flex flex-col items-start gap-4 bg-card p-6">
        <h1 className="text-xl font-semibold tracking-tight">Install Teire on a repository</h1>
        <p className="text-sm text-muted-foreground">
          Pick the account and the repositories on GitHub. Teire scans each one within minutes and opens a
          pull request named Configure Teire with what it found; merge it to turn Teire on.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild shape="pill">
            <a href={INSTALL_URL}>
              <GithubMark className="size-4" />
              Install on GitHub
            </a>
          </Button>
          <Button asChild shape="pill" variant="outline">
            <Link href="/scan">Scan a public repo first</Link>
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-4 bg-card p-6 text-sm">
        <div>
          <p className="mb-2 font-medium">Teire will</p>
          <ul className="flex flex-col gap-2">
            {WILL.map((w) => (
              <li key={w} className="flex gap-2 text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-clear" aria-hidden />
                {w}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-2 font-medium">Teire won&apos;t</p>
          <ul className="flex flex-col gap-2">
            {WONT.map((w) => (
              <li key={w} className="flex gap-2 text-muted-foreground">
                <X className="mt-0.5 size-4 shrink-0 text-affected" aria-hidden />
                {w}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
