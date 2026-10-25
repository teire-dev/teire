import { ArrowRight, FileSearch, GitPullRequest, ScanSearch, ShieldCheck, Wrench } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { GithubMark } from "@/components/icons";
import { DeadlineStrip, DeadlineStripSkeleton } from "@/components/landing/deadline-strip";
import { ExamplePr } from "@/components/landing/example-pr";
import { Button } from "@/components/ui/button";
import { ECOSYSTEMS, SPONSORS } from "@/lib/brands";
import { CURATED } from "@/lib/logos";
import { INSTALL_URL } from "@/lib/site";

export const metadata = {
  title: { absolute: "Teire: when a package, API or model changes, Teire fixes your code" },
};

/** The five steps every run takes (C3–C6), each with the tool or model that does it. */
const STEPS = [
  {
    icon: FileSearch,
    title: "Notice",
    body: "Reads only what your code uses: registries for every locked package, and the change pages of the APIs your code calls.",
    tool: "registries · provider pages · OSV",
  },
  {
    icon: ScanSearch,
    title: "Impact",
    body: "Diffs the API surface between your version and the next, then finds the exact lines that use what changed.",
    tool: "tsc · griffe · apidiff · japicmp",
  },
  {
    icon: Wrench,
    title: "Fix",
    body: "Applies the replacement the source names, and lets a coding agent edit what a rename cannot.",
    tool: "Nemotron 3 Ultra",
  },
  {
    icon: ShieldCheck,
    title: "Verify",
    body: "Installs in a sandbox, then runs your own typecheck and tests before and after the change, with the network off.",
    tool: "your checks · sandbox",
  },
  {
    icon: GitPullRequest,
    title: "Pull request",
    body: "Opens a ready PR when your checks pass before and after, a draft that says what could not be checked, or an issue for a person.",
    tool: "quoted sources · receipt",
  },
] as const;

const FAQ = [
  {
    q: "What does Teire need from GitHub?",
    a: "Contents (to read the code and push one branch per fix), pull requests, issues and checks to write, and Actions logs to read when your CI fails on its PR. The trust page explains each one.",
  },
  {
    q: "Which model sees my code?",
    a: "NVIDIA Nemotron 3 Ultra on Nebius Token Factory reads change pages and writes fixes; Nemotron 3 Super takes over only while Ultra is unavailable. Every call is listed with its tokens and cost on the run's receipt.",
  },
  {
    q: "Will it flood my repo with PRs?",
    a: "One PR per package and target version, at most five open and two new per hour by default. teire.yml turns off plain version bumps or limits Teire to the packages you name, and a PR you close stays closed.",
  },
  {
    q: "What if the fix cannot be proven?",
    a: "Then the PR is not ready. When a check could not run in the sandbox, or already failed before the change, it is a draft that says so. When the fix breaks a check or runs out of attempts, Teire opens an issue for a person, with its best diff and the evidence.",
  },
] as const;

export default function Home() {
  return (
    <main className="flex flex-col">
      <section className="relative overflow-hidden border-b">
        <Schematic />
        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-16 md:py-24 lg:grid-cols-[1.05fr_1fr]">
          <div className="flex animate-enter flex-col gap-6">
            <p className="font-mono text-xs text-muted-foreground">
              npm · PyPI · Go · Cargo · RubyGems · Maven · APIs · models
            </p>
            <h1 className="text-4xl font-semibold tracking-[-0.045em] md:text-5xl md:leading-[1.08]">
              When a package, API or model changes, Teire fixes your code.
            </h1>
            <p className="max-w-xl text-base text-subtle md:text-lg">
              A Nemotron coding agent on Nebius Token Factory finds the lines that break, fixes them, runs
              your own tests before and after, and opens a pull request.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild shape="pill" size="lg">
                <a href={INSTALL_URL}>
                  <GithubMark className="size-4" />
                  Install on GitHub
                </a>
              </Button>
              <Button asChild shape="pill" size="lg" variant="outline">
                <Link href="/scan">
                  Scan a public repo
                  <ArrowRight data-icon="inline-end" />
                </Link>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Or from a terminal: <code className="font-mono text-foreground">npx teire scan</code>
            </p>
          </div>
          <div className="animate-enter [animation-delay:80ms]">
            <ExamplePr />
          </div>
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-12">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-medium">Next shutdowns in the catalog</h2>
          <Link href="/changes" className="text-sm text-link hover:underline">
            All changes
          </Link>
        </div>
        <Suspense fallback={<DeadlineStripSkeleton />}>
          <DeadlineStrip />
        </Suspense>
      </section>

      <section className="border-y bg-card/50">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-16">
          <div className="flex max-w-2xl flex-col gap-3">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
              From a notice to a reviewed fix
            </h2>
            <p className="text-subtle">
              A version bump is the easy part. Teire does the work after it: it finds what the new version
              removes or renames, edits the lines that use it, and proves the result with the checks you
              already trust.
            </p>
          </div>
          <ol className="grid gap-px overflow-hidden rounded-lg bg-border shadow-card md:grid-cols-5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex flex-col gap-3 bg-card p-5">
                <div className="flex items-center justify-between">
                  <s.icon className="size-4" aria-hidden />
                  <span className="font-mono text-xs text-muted-foreground">0{i + 1}</span>
                </div>
                <h3 className="font-medium">{s.title}</h3>
                <p className="text-sm text-muted-foreground">{s.body}</p>
                <p className="mt-auto font-mono text-xs text-subtle">{s.tool}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            Six package ecosystems, read to the symbol
          </h2>
          <p className="text-subtle">
            Teire reads the exact versions your lockfiles pin and compares each one's public API with the
            version you would upgrade to, using each ecosystem's own tooling.
          </p>
          <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border shadow-card sm:grid-cols-3">
            {Object.entries(ECOSYSTEMS).map(([key, e]) => (
              <li key={key} className="flex flex-col gap-2 bg-card p-4">
                <BrandLogo light={e.light} dark={e.dark} alt="" className="h-6" />
                <span className="text-sm font-medium">{e.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{e.reads}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold tracking-tight">Every API your code calls</h2>
          <p className="text-subtle">
            Model retirements, removed endpoints and parameters, read from each provider&apos;s own pages and
            kept only when the quote matches the page. Teire reads a provider only when a repository calls it.
          </p>
          <div className="rounded-lg bg-card p-5 shadow-card">
            <p className="mb-4 text-xs text-muted-foreground">Readers built for their change pages</p>
            <ul className="flex flex-wrap items-center gap-x-6 gap-y-4">
              {CURATED.map((p) => (
                <li key={p.slug} className="flex items-center gap-2 text-sm">
                  <BrandLogo light={p.light} dark={p.dark} alt="" className="h-5" />
                  {p.name}
                </li>
              ))}
            </ul>
            <p className="mt-5 border-t pt-4 text-sm text-muted-foreground">
              Any other API host in your code or your SDKs is discovered from the code itself, and its notices
              are read by Nemotron the same way.
            </p>
          </div>
        </div>
      </section>

      <section className="border-y bg-card/50">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-16 lg:grid-cols-[1fr_1.1fr]">
          <div className="flex flex-col gap-4">
            <h2 className="text-2xl font-semibold tracking-tight">
              Built on NVIDIA Nemotron and Nebius Token Factory
            </h2>
            <p className="text-subtle">
              Nemotron 3 Ultra reads every change page and writes every fix; Nemotron 3 Super steps in only
              while Ultra is unavailable. Each call, its tokens and its cost appear on the run&apos;s receipt.
            </p>
            <div className="flex flex-wrap items-center gap-8 pt-2">
              <BrandLogo
                light={SPONSORS.nvidia.light}
                dark={SPONSORS.nvidia.dark}
                alt="NVIDIA"
                className="h-6"
              />
              <BrandLogo
                light={SPONSORS.nebius.light}
                dark={SPONSORS.nebius.dark}
                alt="Nebius"
                className="h-5"
              />
              <BrandLogo
                light={SPONSORS.tavily.light}
                dark={SPONSORS.tavily.dark}
                alt="Tavily"
                className="h-5"
              />
            </div>
          </div>
          <div className="overflow-hidden rounded-lg bg-card shadow-card">
            <div className="flex gap-1 border-b px-3 py-2 font-mono text-xs text-muted-foreground">
              <span>terminal</span>
            </div>
            <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-6">
              <span className="text-muted-foreground"># the same scan, on your machine</span>
              {"\n"}npx teire scan
              {"\n"}
              {"\n"}
              <span className="text-muted-foreground">
                # fail CI when an affected change is due within 60 days
              </span>
              {"\n"}npx teire check --fail-on deadline --within 60
              {"\n"}
              {"\n"}
              <span className="text-muted-foreground"># give your coding agent the same tools</span>
              {"\n"}claude mcp add teire -- npx -y teire mcp
            </pre>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 lg:grid-cols-[1fr_2fr]">
        <h2 className="text-2xl font-semibold tracking-tight">Questions</h2>
        <dl className="grid gap-px overflow-hidden rounded-lg bg-border shadow-card sm:grid-cols-2">
          {FAQ.map((f) => (
            <div key={f.q} className="flex flex-col gap-2 bg-card p-5">
              <dt className="font-medium">{f.q}</dt>
              <dd className="text-sm text-muted-foreground">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-6 px-4 py-16 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">See what would break in your repository</h2>
            <p className="text-subtle">Paste any public GitHub repository; the report takes a few minutes.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild shape="pill" size="lg">
              <Link href="/scan">Scan a public repo</Link>
            </Button>
            <Button asChild shape="pill" size="lg" variant="outline">
              <Link href="/trust">How Teire runs</Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

/** One line-art schematic behind the hero (design ledger: at most one, never behind app UI). */
function Schematic() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full text-border [mask-image:radial-gradient(ellipse_at_top_right,black,transparent_70%)]"
    >
      <defs>
        <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M32 0H0V32" fill="none" stroke="currentColor" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />
    </svg>
  );
}
