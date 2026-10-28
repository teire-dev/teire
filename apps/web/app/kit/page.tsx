import { ArrowRight, MessageCircleQuestion } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyState } from "@/components/teire/empty-state";
import { Ledger, type LedgerCheck, notCoveredFrom } from "@/components/teire/ledger";
import { LiveDot } from "@/components/teire/live-dot";
import { ProofChain, ProofGlyphs } from "@/components/teire/proof-chain";
import { EvidenceChip, StatusChip } from "@/components/teire/status-chip";
import { Surface } from "@/components/teire/surface";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { kitRun, kitRuns, requireKit } from "@/lib/kit";
import { cn } from "@/lib/utils";

export const metadata = { title: "Primitives" };

export default function KitPage() {
  return (
    <Suspense fallback={<div className="m-8 h-96 animate-pulse rounded-lg bg-sheet shadow-card" />}>
      <Kit />
    </Suspense>
  );
}

const TOKENS = [
  ["canvas", "page"],
  ["sheet", "cards, panels"],
  ["sunken", "inputs, code, cells"],
  ["ink", "text"],
  ["ink-2", "secondary text"],
  ["ink-3", "labels (≥ 5.1:1)"],
  ["rule", "1px structure"],
  ["rule-strong", "strong rule"],
  ["signal", "Teire acting"],
  ["proven", "verified"],
  ["attention", "draft, deadline"],
  ["broke", "regression"],
] as const;

async function Kit() {
  await connection();
  await requireKit();
  const runs = await kitRuns();
  const verified = runs.find((r) => r.evidence === "verified" && r.pr);
  const draft = runs.find((r) => r.evidence && r.evidence !== "verified" && r.pr);
  const live = runs.find((r) => r.status === "running");
  const sample = verified ? await kitRun(verified.id) : null;
  const baseline = (sample?.verification?.baseline ?? []) as LedgerCheck[];
  const after = (sample?.verification?.after ?? []) as LedgerCheck[];

  const board = (
    <div className="flex flex-col gap-6">
      <Surface eyebrow="Tokens" flush>
        <ul className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-3">
          {TOKENS.map(([name, role]) => (
            <li key={name} className="flex items-center gap-3 bg-sheet px-3 py-2.5">
              <span
                className="size-7 shrink-0 rounded-md ring-1 ring-rule ring-inset"
                style={{ background: `var(--${name})` }}
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-mono text-xs text-ink">{name}</span>
                <span className="truncate text-[11px] text-ink-3">{role}</span>
              </span>
            </li>
          ))}
        </ul>
      </Surface>

      <Surface eyebrow="Type">
        <div className="flex flex-col gap-3">
          <p className="display text-5xl text-ink">Proven fixes.</p>
          <p className="heading text-2xl text-ink">What needs you</p>
          <p className="text-sm text-ink-2">
            Body 14px in the app: the run changed two files and your checks passed before and after.
          </p>
          <p className="font-mono text-xs text-ink">claude-3-5-sonnet-20241022 → claude-sonnet-5-5 · 70/70</p>
          <p className="eyebrow">Eyebrow · mono uppercase</p>
        </div>
      </Surface>

      <Surface eyebrow="Status">
        <div className="flex flex-wrap items-center gap-2">
          <EvidenceChip kind="verified" />
          <EvidenceChip kind="environment_mismatch" />
          <EvidenceChip kind="regression" />
          <StatusChip tone="signal">Running</StatusChip>
          <StatusChip tone="attention">in 34 days</StatusChip>
          <StatusChip tone="neutral">public</StatusChip>
          <span className="flex items-center gap-2 text-xs text-ink-2">
            <LiveDot /> live dot
          </span>
        </div>
      </Surface>

      <Surface eyebrow="Proof chain" title="Real runs: verified, draft and live">
        <div className="flex flex-col gap-5">
          {[verified, draft, live].map((r) =>
            r ? (
              <div key={r.id} className="flex flex-col gap-2">
                <Link href={`/kit/run/${r.id}`} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-mono text-ink-2">
                    {r.repo.split("/")[1]} · {r.groupKey}
                  </span>
                  <ProofGlyphs proof={r.proof} />
                </Link>
                <ProofChain proof={r.proof} />
              </div>
            ) : null,
          )}
        </div>
      </Surface>

      {sample ? (
        <Surface eyebrow="Ledger" title={`${sample.repo.fullName} · ${sample.run.groupKey}`} flush>
          <div className="py-3">
            <Ledger
              baseline={baseline}
              after={after}
              evidence={sample.run.evidenceKind}
              notCovered={notCoveredFrom(baseline, after, sample.verification?.reasons ?? [])}
            />
          </div>
        </Surface>
      ) : null}

      <Surface eyebrow="Controls">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">
            Install on GitHub
            <ArrowRight data-icon="inline-end" />
          </Button>
          <Button size="sm" variant="outline">
            Rescan
          </Button>
          <Button size="sm" variant="ghost">
            <MessageCircleQuestion data-icon="inline-start" />
            Explain
          </Button>
          <ToggleGroup type="single" defaultValue="auto" variant="outline" size="sm" aria-label="Fix mode">
            <ToggleGroupItem value="auto">Automatic</ToggleGroupItem>
            <ToggleGroupItem value="ask">Ask first</ToggleGroupItem>
            <ToggleGroupItem value="off">Off</ToggleGroupItem>
          </ToggleGroup>
          <Switch defaultChecked aria-label="Security fixes automatic" />
        </div>
      </Surface>

      <Surface eyebrow="Empty and loading" flush>
        <EmptyState
          title="No open pull requests"
          body="When a change reaches your code, its fix opens here with the proof."
          action={<Button size="sm">Scan a public repo</Button>}
          preview={
            <div className="flex flex-col gap-2 p-4">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-md bg-sunken px-3 py-2 ring-1 ring-rule ring-inset"
                >
                  <span className="h-2 w-24 rounded bg-rule-strong" />
                  <span className="ml-auto font-mono text-xs text-ink-3">✓ ✓ ✓ ✓ ✓</span>
                </div>
              ))}
            </div>
          }
        />
        <div className="flex flex-col gap-2 border-t border-rule p-4">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </Surface>
    </div>
  );

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">U0 · Kit</span>
          <h1 className="heading text-2xl">Primitives, light and dark, on real runs</h1>
        </div>
        <nav className="flex flex-wrap gap-3 text-sm">
          {[
            ["Overview", "/kit/overview"],
            ["Repository + Ask Teire", "/kit/repo/teire-dev/bristow"],
            ["Run proof sheet", verified ? `/kit/run/${verified.id}` : "/kit/runs"],
            ["Runs", "/kit/runs"],
          ].map(([label, href]) => (
            <Link key={href} href={href} className="entity-link text-ink-2">
              {label}
            </Link>
          ))}
        </nav>
      </header>
      <div className="grid gap-6 xl:grid-cols-2">
        <section
          aria-label="Light"
          className={cn("light rounded-xl bg-canvas p-4 text-ink ring-1 ring-rule")}
        >
          {board}
        </section>
        <section aria-label="Dark" className="dark rounded-xl bg-canvas p-4 text-ink ring-1 ring-rule">
          {board}
        </section>
      </div>
    </main>
  );
}
