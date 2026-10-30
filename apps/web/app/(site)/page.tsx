import { ArrowRight, ArrowUpRight, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { HeroShader } from "@/components/brand/dot-grid";
import { BrandLogo } from "@/components/brand-logo";
import { DeadlineRail } from "@/components/deadline-rail";
import { MiniFlow } from "@/components/flow/mini-flow";
import { Connector } from "@/components/flow/static-flow";
import { TileLabel, TileSquare } from "@/components/flow/tile";
import { GithubMark } from "@/components/icons";
import { CopyCommand } from "@/components/landing/copy-command";
import { ProofCard } from "@/components/landing/proof-card";
import { Reveal, ScrollSpine } from "@/components/landing/scroll-flow";
import { Button } from "@/components/ui/button";
import { ECOSYSTEMS, SPONSORS, STACK } from "@/lib/brands";
import type { FlowTile } from "@/lib/flow/model";
import hero from "@/lib/landing/hero-run.json";
import { CURATED, providerLogo } from "@/lib/logos";
import { subjectMark } from "@/lib/marks";
import type { Proof } from "@/lib/proof";
import { INSTALL_URL, NPM_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

export const metadata = {
  title: { absolute: "Teire: when upstream breaks, Teire fixes your code" },
};

/**
 * The landing is one flow (plan revision 3.4, B1/C3–C5): the stations of a real verified run, read
 * from its committed snapshot (`lib/landing/hero-run.json`, `pnpm hero-run`), joined by one line that
 * draws as you scroll. What belongs to a station hangs at its side: other change kinds and the live
 * deadlines at the change, what Teire reads at the repository, the model and its platform at the fix,
 * more real PRs at the PR. Words only where a sentence earns its place.
 */
/** A linked PR's chain, from its own run's evidence in the snapshot. */
const proofOf = (m: { evidence: string | null; mode: string | null; draft: boolean }): Proof => ({
  changed: { state: "done" },
  reaches: { state: "done" },
  fixed: { state: "done" },
  proven:
    m.evidence === "verified"
      ? { state: "done", detail: "verified" }
      : { state: "not_proven", detail: m.evidence ?? "" },
  pr: { state: "done", detail: m.draft || m.mode === "draft" ? "draft" : "ready" },
});
/** "gemini-2.0-flash → gemini-3.6-flash", "pydantic 1.10.18 → 2.14.1": a linked change in mono. */
const _changeOf = (m: { groupKey: string | null; from: string | null; to: string | null }) => {
  const [kind, name] = (m.groupKey ?? "").split("/");
  return kind === "models" || kind === "api" ? `${m.from} → ${m.to}` : `${name} ${m.from} → ${m.to}`;
};

const MORE_MARK: Record<string, { light: string; dark: string; label: string }> = {
  "teire-dev/nlsh#6": { ...providerLogo("google-gemini"), label: "Google Gemini" },
  "teire-dev/examples#16": ECOSYSTEMS.pypi as { light: string; dark: string; label: string },
  "teire-dev/serve-handler#16": ECOSYSTEMS.npm as { light: string; dark: string; label: string },
};

const tile = (t: Omit<FlowTile, "id">): FlowTile => ({ id: t.entity, ...t });

export default function Home() {
  const subject = subjectMark(hero.run.groupKey);
  const [owner, name] = hero.repo.split("/");
  const tests = hero.checks.tests;
  return (
    <main className="flex flex-col">
      {/* The one dark band (≤60vh, ≤50vh on phones): the promise, two actions, the flow's first tile on its edge. */}
      <section data-hero className="relative isolate -mt-16 overflow-hidden bg-hero pt-16 text-hero-ink">
        <HeroShader className="absolute inset-0 -z-10" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-b from-transparent to-hero-2/30" />
        {/* The thumbnail the owner chose (revamp S4): the promise on the left, the real run's proof on
            the right, the pen's ring on what passed. */}
        <div className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] items-center gap-10 px-4 pt-6 pb-[4.5rem] sm:pt-10 sm:pb-20 lg:grid-cols-[minmax(0,1fr)_480px] lg:gap-6">
          <div className="flex flex-col items-center gap-5 text-center lg:items-start lg:text-left">
            <Link
              href={hero.run.href}
              className="group inline-flex items-center gap-2 rounded-full bg-white/8 py-1 pr-3 pl-1 text-[13px] text-hero-ink-2 shadow-[inset_0_0_0_1px_var(--hero-rule)] backdrop-blur transition-colors hover:text-hero-ink"
            >
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-hero-ink">
                <span className="size-1.5 rounded-full bg-hero-proven" />
                Live proof
              </span>
              {hero.repo} · PR #{hero.pr.number}
              <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <h1 className="display max-w-2xl text-[34px] leading-[1.02] text-hero-ink min-[400px]:text-[40px] sm:text-6xl lg:text-[68px]">
              When upstream breaks, <em className="font-normal text-cta italic">Teire fixes your code.</em>
            </h1>
            <p className="max-w-xl text-[15px] text-hero-ink-2 sm:text-[17px]">
              Dependabot bumps the version. Teire fixes the code it breaks, and proves it with your own tests.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <Button asChild variant="cta" size="xl" shape="pill">
                <a href={INSTALL_URL}>
                  <GithubMark className="size-4" />
                  Install on GitHub
                </a>
              </Button>
              <Button asChild variant="hero" size="xl" shape="pill">
                <Link href="/scan">
                  Scan a repo
                  <ArrowRight data-icon="inline-end" />
                </Link>
              </Button>
            </div>
            <div className="hidden flex-wrap items-center gap-4 sm:flex">
              <CopyCommand command="npx teire-cli scan" tone="hero" />
              <a
                href={NPM_URL}
                className="inline-flex items-center gap-2 text-sm text-hero-ink-2 transition-colors hover:text-hero-ink"
              >
                <BrandLogo light={ECOSYSTEMS.npm.dark} alt="" className="h-4" />
                View teire-cli on npm
                <ArrowUpRight className="size-3.5" />
              </a>
            </div>
          </div>
          <ProofCard className="mx-auto" />
        </div>
      </section>

      {/* The run, station by station, on the spine. */}
      <div className="relative -mt-12 bg-canvas">
        <div className="mx-auto w-full max-w-6xl px-4 pb-8">
          <ScrollSpine>
            <Station
              tile={tile({ entity: "change", state: "done", label: hero.run.package, brand: subject })}
              title="Upstream changes"
              line="An advisory, on a new major."
              side={
                <div className="flex flex-col gap-3 md:items-end">
                  <span className="eyebrow">Also</span>
                  {hero.more.slice(0, 2).map((m) => {
                    const mark = MORE_MARK[`${m.repo}#${m.number}`];
                    return (
                      <a
                        key={m.url}
                        href={m.url}
                        className="flex items-center gap-2.5 rounded-full bg-sheet py-1 pr-3 pl-1 text-[13px] shadow-card hover:shadow-card-hover"
                      >
                        {mark ? (
                          <span className="flex size-7 items-center justify-center rounded-full bg-sunken">
                            <BrandLogo light={mark.light} dark={mark.dark} alt="" className="h-3.5 max-w-5" />
                          </span>
                        ) : null}
                        <span className="max-w-56 truncate">
                          {m.title.replace(/ and adapt the code$/, "")}
                        </span>
                      </a>
                    );
                  })}
                </div>
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-sheet px-3 py-1 font-mono text-[13px] shadow-card">
                  {hero.run.package} {hero.run.from} → {hero.run.to}
                </span>
                {hero.advisory ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-broke-soft px-3 py-1 font-mono text-[12px] text-broke">
                    <ShieldAlert className="size-3.5" />
                    {hero.advisory.id} · {hero.advisory.severity}
                  </span>
                ) : null}
              </div>
              <div className="mt-6">
                <p className="eyebrow mb-3">Next shutdowns</p>
                <Suspense fallback={<div className="h-16 shimmer rounded-card" />}>
                  <DeadlineRail max={6} />
                </Suspense>
              </div>
            </Station>

            <Station
              tile={tile({
                entity: "repository",
                state: "done",
                label: name ?? hero.repo,
                meta: owner,
                brand: SPONSORS.github,
              })}
              title={hero.repo}
              line={`The installed ${hero.run.package} is vulnerable.`}
              side={
                <div className="flex flex-col gap-3 md:items-end">
                  <span className="eyebrow">Teire reads</span>
                  <div className="flex max-w-64 flex-wrap gap-2 md:justify-end">
                    {Object.values(ECOSYSTEMS).map((e) => (
                      <span
                        key={e.label}
                        title={e.label}
                        className="flex size-9 items-center justify-center rounded-[11px] bg-sheet shadow-card"
                      >
                        <BrandLogo light={e.light} dark={e.dark} alt={e.label} className="h-4.5 max-w-6" />
                      </span>
                    ))}
                    {CURATED.slice(0, 8 - Object.keys(ECOSYSTEMS).length + 2).map((p) => (
                      <Link
                        key={p.slug}
                        href={`/providers/${p.slug}`}
                        title={p.name}
                        className="flex size-9 items-center justify-center rounded-[11px] bg-sheet shadow-card hover:shadow-card-hover"
                      >
                        <BrandLogo light={p.light} dark={p.dark} alt={p.name} className="h-4 max-w-6" />
                      </Link>
                    ))}
                  </div>
                </div>
              }
            >
              <span className="inline-flex items-center gap-2 self-start rounded-full bg-attention-soft px-3 py-1 font-mono text-[12px] text-attention">
                {hero.run.package} {hero.run.from} installed
              </span>
            </Station>

            <Station
              tile={tile({ entity: "fix", state: "done", label: "Nemotron 3 Ultra", brand: STACK.nemotron })}
              title="Nemotron fixes it"
              line="Nemotron rewrites what broke."
              side={
                <div className="flex flex-col gap-3 md:items-end">
                  <span className="eyebrow">On</span>
                  <div className="flex items-center gap-3">
                    <BrandLogo
                      light={SPONSORS.nvidia.light}
                      dark={SPONSORS.nvidia.dark}
                      alt="NVIDIA"
                      className="h-5"
                    />
                    <BrandLogo
                      light={SPONSORS.nebius.light}
                      dark={SPONSORS.nebius.dark}
                      alt="Nebius Token Factory"
                      className="h-4"
                    />
                  </div>
                </div>
              }
            >
              <div className="flex flex-col gap-4">
                <ol className="flex flex-col [--tile:44px] md:flex-row md:items-center">
                  <li className="flex items-center gap-3">
                    <TileSquare
                      size="sm"
                      tile={{
                        entity: "update",
                        state: "done",
                        label: "dependabot-core",
                        brand: STACK.dependabot,
                      }}
                    />
                    <TileLabel
                      size="sm"
                      className="items-start text-left"
                      tile={{
                        label: "dependabot-core",
                        meta: hero.updaterSeconds ? `${hero.updaterSeconds} s` : undefined,
                        state: "done",
                      }}
                    />
                  </li>
                  <li aria-hidden className="contents">
                    <Connector link={{ state: "done" }} className="md:max-w-16 md:min-w-12" />
                  </li>
                  <li className="flex items-center gap-3">
                    <TileSquare
                      size="sm"
                      tile={{ entity: "fix", state: "done", label: "Nemotron", brand: STACK.nemotron }}
                    />
                    <TileLabel
                      size="sm"
                      className="items-start text-left"
                      tile={{
                        label: "Nemotron 3 Ultra",
                        meta: `${hero.fix.calls} calls · $${hero.fix.costUsd}`,
                        state: "done",
                      }}
                    />
                  </li>
                </ol>
                {hero.diff.peek ? (
                  <figure className="overflow-hidden rounded-card bg-console font-mono text-[12px] text-console-ink shadow-tile">
                    <figcaption className="flex items-center justify-between gap-3 border-b border-console-rule px-4 py-2 text-console-ink-2">
                      <span className="truncate">{hero.diff.peek.file}</span>
                      <span data-flow>
                        {hero.diff.sourceFiles} files adapted ·{" "}
                        <span className="text-console-add">+{hero.diff.srcAdded}</span>{" "}
                        <span className="text-console-del">−{hero.diff.srcRemoved}</span>
                      </span>
                    </figcaption>
                    <pre className="overflow-x-auto py-2 leading-6">
                      {hero.diff.peek.lines.map((l, i) => (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed snapshot's lines
                          key={i}
                          className={cn(
                            "block px-4",
                            l.kind === "add" && "bg-console-add/10 text-console-add",
                            l.kind === "del" && "bg-console-del/10 text-console-del",
                          )}
                        >
                          <span className="pr-3 opacity-60 select-none">
                            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                          </span>
                          {l.text}
                        </span>
                      ))}
                    </pre>
                  </figure>
                ) : null}
              </div>
            </Station>

            <Station
              tile={tile({ entity: "sandbox", state: "done", label: "Sandbox" })}
              title="In a sandbox"
              line="Installs online, checks offline."
            >
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full bg-sheet px-3 py-1 text-[13px] shadow-card">
                  Token Factory Sandboxes
                </span>
                <span className="rounded-full bg-sheet px-3 py-1 text-[13px] shadow-card">
                  Your repo&apos;s own commands
                </span>
              </div>
            </Station>

            <Station
              tile={tile({ entity: "check", state: "proven", label: "Your checks" })}
              title="Your tests prove it"
              line="Before and after the change."
            >
              <dl className="grid max-w-md grid-cols-2 gap-3">
                <Figure label="tests" before={tests.before ?? "–"} after={tests.after ?? "–"} />
                <Figure
                  label="typecheck"
                  before={hero.checks.typecheck.before ? "pass" : "fail"}
                  after={hero.checks.typecheck.after ? "pass" : "fail"}
                />
              </dl>
            </Station>

            <Station
              last
              tile={tile({
                entity: "outcome",
                state: "proven",
                label: "Pull request",
                meta: `#${hero.pr.number}`,
                href: hero.pr.url ?? undefined,
              })}
              title="One pull request"
              line="With the proof inside."
              side={
                <div className="flex flex-col gap-3 md:items-end">
                  <span className="eyebrow">More real PRs</span>
                  {hero.more.map((m) => {
                    const mark = MORE_MARK[`${m.repo}#${m.number}`];
                    return (
                      <a
                        key={m.url}
                        href={m.url}
                        className="flex w-full max-w-72 items-center gap-3 rounded-card bg-sheet p-2.5 shadow-card hover:shadow-card-hover"
                      >
                        <MiniFlow size="xs" proof={proofOf(m)} {...(mark ? { subject: mark } : {})} />
                        <span className="min-w-0 text-left">
                          <span className="block truncate text-[13px] font-medium">{m.title}</span>
                          <span className="block font-mono text-[11px] text-ink-3">
                            {m.repo} #{m.number}
                          </span>
                        </span>
                      </a>
                    );
                  })}
                </div>
              }
            >
              <a
                href={hero.pr.url ?? undefined}
                className="group flex max-w-lg items-start gap-3 rounded-card bg-sheet p-4 shadow-card hover:shadow-card-hover"
              >
                <GithubMark className="mt-0.5 size-5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-[15px] font-medium leading-snug">{hero.pr.title}</span>
                  <span className="mt-1 block font-mono text-xs text-ink-3">
                    {hero.repo} #{hero.pr.number} ·{" "}
                    {hero.pr.draft ? "draft" : hero.pr.verified ? "ready · proven" : "ready"}
                  </span>
                </span>
                <ArrowUpRight className="ml-auto size-4 shrink-0 text-ink-3 group-hover:text-ink" />
              </a>
              <Link
                href={hero.run.href}
                className="mt-3 inline-flex items-center gap-1 text-sm text-link hover:underline"
              >
                Open this run <ArrowRight className="size-3.5" />
              </Link>
            </Station>
          </ScrollSpine>
        </div>
      </div>

      {/* Install band. The FAQ's facts live on the trust page; these chips go straight to them. */}
      <section className="mx-auto w-full max-w-6xl px-4 pt-8 pb-24">
        <div className="flex flex-col items-center gap-6 rounded-feature bg-sheet px-6 py-14 text-center shadow-tile">
          <h2 className="display max-w-2xl text-4xl sm:text-5xl">Put Teire on your repos.</h2>
          <div className="flex flex-wrap justify-center gap-3">
            <Button asChild variant="cta" size="xl" shape="pill">
              <a href={INSTALL_URL}>
                <GithubMark className="size-4" />
                Install on GitHub
              </a>
            </Button>
            <Button asChild variant="outline" size="xl" shape="pill">
              <Link href="/scan">Scan a repo</Link>
            </Button>
          </div>
          <CopyCommand command="npx teire-cli scan" />
          <a href={NPM_URL} className="inline-flex items-center gap-2 text-sm text-link hover:underline">
            <BrandLogo light={ECOSYSTEMS.npm.light} alt="" className="h-4" />
            Get teire-cli on npm <ArrowUpRight className="size-3.5" />
          </a>
          <nav aria-label="How Teire runs" className="flex flex-wrap justify-center gap-2 pt-2">
            {[
              ["What Teire can touch", "/trust#permissions"],
              ["Where your code goes", "/trust#code"],
              ["How many PRs", "/docs/guide/configuration"],
              ["Ready, draft or issue", "/docs/guide/anatomy-of-a-pr"],
            ].map(([label, href]) => (
              <Link
                key={href}
                href={href as string}
                className="rounded-full bg-sunken px-3 py-1 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </section>
    </main>
  );
}

/** One station: the tile on the spine, its words beside it, what belongs to it on the other side. */
function Station({
  tile,
  title,
  line,
  side,
  last = false,
  children,
}: {
  tile: FlowTile;
  title: string;
  line: string;
  side?: React.ReactNode;
  last?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "relative grid grid-cols-[80px_1fr] gap-x-5 gap-y-6 py-10 md:grid-cols-[1fr_96px_1fr] md:gap-x-12 md:py-14",
        last && "pb-4",
      )}
    >
      <div className="col-start-1 row-start-1 flex justify-center md:col-start-2">
        <Reveal className="relative z-10">
          <TileSquare tile={tile} size="lg" className="ring-offset-4 ring-offset-canvas" />
        </Reveal>
      </div>
      <Reveal className="col-start-2 row-start-1 flex min-w-0 flex-col gap-4 md:col-start-3">
        <div className="flex flex-col gap-2">
          <h2 className="display text-[30px] md:text-[36px]">{title}</h2>
          <p className="max-w-md text-[15px] text-ink-2">{line}</p>
        </div>
        {children}
      </Reveal>
      {side ? (
        <Reveal className="col-start-2 row-start-2 min-w-0 md:col-start-1 md:row-start-1 md:flex md:justify-end md:pt-2">
          {side}
        </Reveal>
      ) : null}
    </section>
  );
}

/** A before → after figure, huge: the proof in two numbers. */
function Figure({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-card bg-sheet p-4 shadow-card">
      <dt className="font-mono text-[11px] text-ink-3">{label}</dt>
      <dd className="flex flex-wrap items-baseline gap-x-2 font-mono">
        <span className="text-lg text-ink-2 sm:text-xl">{before}</span>
        <ArrowRight className="size-4 self-center text-ink-3" />
        <span className="text-2xl font-medium text-proven sm:text-3xl">{after}</span>
      </dd>
    </div>
  );
}
