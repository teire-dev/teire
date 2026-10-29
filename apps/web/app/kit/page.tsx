import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { MiniFlow } from "@/components/flow/mini-flow";
import { StaticFlow } from "@/components/flow/static-flow";
import { Tile } from "@/components/flow/tile";
import { GithubMark } from "@/components/icons";
import { LogoMark } from "@/components/logo";
import { BrokenFlow } from "@/components/state-page";
import { StatusChip } from "@/components/teire/status-chip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { LeafBurst } from "@/components/welcome/leaf-burst";
import { SPONSORS, STACK } from "@/lib/brands";
import { type FlowEntity, type FlowState, proofFlow, type RunFlowInput, runFlow } from "@/lib/flow/model";
import { kitRuns, requireKit } from "@/lib/kit";
import { subjectMark } from "@/lib/marks";
import type { Proof, ProofState } from "@/lib/proof";
import { cn } from "@/lib/utils";

export const metadata = { title: "System" };

/**
 * The living design system (plan revision 3.4, D140): tokens, type, controls, and every flow part in
 * every state, light and dark side by side. The flows at the bottom are real kit runs.
 */
export default function KitPage() {
  return (
    <Suspense fallback={<div className="m-8 h-96 shimmer rounded-card" />}>
      <Kit />
    </Suspense>
  );
}

const SWATCHES = [
  ["canvas", "bg-canvas"],
  ["sheet", "bg-sheet"],
  ["sunken", "bg-sunken"],
  ["ink", "bg-ink"],
  ["ink-2", "bg-ink-2"],
  ["ink-3", "bg-ink-3"],
  ["cta", "bg-cta"],
  ["signal", "bg-signal"],
  ["proven", "bg-proven"],
  ["attention", "bg-attention"],
  ["broke", "bg-broke"],
  ["hero", "bg-hero"],
  ["console", "bg-console"],
] as const;

const STATES: FlowState[] = ["pending", "live", "done", "proven", "not_proven", "failed", "skipped"];
const ENTITIES: {
  entity: FlowEntity;
  label: string;
  brand?: (typeof STACK)[keyof typeof STACK] | (typeof SPONSORS)["github"];
}[] = [
  { entity: "change", label: "Change" },
  { entity: "repository", label: "Repository", brand: SPONSORS.github },
  { entity: "code", label: "Your code" },
  { entity: "update", label: "dependabot-core", brand: STACK.dependabot },
  { entity: "fix", label: "Nemotron 3 Ultra", brand: STACK.nemotron },
  { entity: "sandbox", label: "Sandbox", brand: STACK.tokenFactory },
  { entity: "check", label: "Your checks" },
  { entity: "outcome", label: "Pull request" },
];

const proofOf = (s: ProofState[]): Proof => ({
  changed: { state: s[0] as ProofState },
  reaches: { state: s[1] as ProofState },
  fixed: { state: s[2] as ProofState },
  proven: { state: s[3] as ProofState },
  pr: { state: s[4] as ProofState },
});
const MINI: [string, ProofState[]][] = [
  ["Proven, PR open", ["done", "done", "done", "done", "done"]],
  ["Live: fixing", ["done", "done", "live", "pending", "pending"]],
  ["Not proven: draft", ["done", "done", "done", "not_proven", "done"]],
  ["Failed: issue", ["done", "done", "failed", "not_applicable", "not_applicable"]],
  ["Plain bump", ["done", "not_applicable", "done", "done", "done"]],
];

/** The run spine in every state it can be in (component states, not product data). */
const BASE: RunFlowInput = {
  kind: "fix",
  status: "succeeded",
  step: null,
  evidenceKind: "verified",
  prMode: "ready",
  sites: 2,
  advisory: false,
  artifact: { kind: "pr", url: null, number: 30 },
  subject: STACK.dependabot,
  subjectLabel: "zod",
  repo: { fullName: "teire-dev/examples" },
  agent: { calls: 22 },
  backend: "tokenfactory",
  checksFigure: "4/4 → 4/4",
};
const SPINES: [string, RunFlowInput][] = [
  ["queued", { ...BASE, status: "queued", evidenceKind: null, prMode: null, artifact: null }],
  [
    "live · fixing",
    { ...BASE, status: "running", step: "agent", evidenceKind: null, prMode: null, artifact: null },
  ],
  ["proven", BASE],
  ["not proven · draft", { ...BASE, evidenceKind: "pre_existing_failure", prMode: "draft" }],
  [
    "failed · issue",
    {
      ...BASE,
      status: "failed",
      evidenceKind: "regression",
      prMode: "issue",
      artifact: { kind: "issue", url: null, number: 25 },
      lastStep: "verify",
    },
  ],
  [
    "cancelled",
    { ...BASE, status: "cancelled", evidenceKind: null, prMode: null, artifact: null, lastStep: "install" },
  ],
  ["dry run", { ...BASE, kind: "dry_run", artifact: null, preview: true }],
  ["plain bump", { ...BASE, sites: null, agent: null }],
];

function Board({ dark = false }: { dark?: boolean }) {
  return (
    <div
      className={cn(
        dark ? "dark" : "light",
        "min-w-0 rounded-feature bg-canvas p-6 text-ink shadow-card sm:p-8",
      )}
    >
      <section className="flex flex-col gap-4">
        <p className="eyebrow">Colour</p>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          {SWATCHES.map(([name, cls]) => (
            <div key={name} className="flex flex-col gap-1.5">
              <span className={cn("h-10 rounded-control shadow-card", cls)} />
              <span className="font-mono text-[11px] text-ink-3">{name}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-10 flex flex-col gap-3">
        <p className="eyebrow">Type</p>
        <p className="display text-5xl">When upstream breaks, Teire fixes it.</p>
        <p className="heading text-2xl">Repositories · app heading in Geist</p>
        <p className="text-sm text-ink-2">Body text in Geist, 14px.</p>
        <p className="font-mono text-xs text-ink-3">zod 3.25.76 → 4.6.6 · src/schema.ts:42</p>
      </section>

      <section className="mt-10 flex flex-col gap-4">
        <p className="eyebrow">Actions</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="cta" size="xl" shape="pill">
            <GithubMark className="size-4" />
            Install on GitHub
          </Button>
          <Button variant="outline" size="xl" shape="pill">
            Scan a repo
            <ArrowRight data-icon="inline-end" />
          </Button>
          <Button>Fix now</Button>
          <Button variant="outline">Rescan</Button>
          <Button variant="ghost">Ignore</Button>
          <Button variant="destructive">Cancel run</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <ToggleGroup type="single" defaultValue="auto" variant="outline" size="sm">
            <ToggleGroupItem value="auto">Automatic</ToggleGroupItem>
            <ToggleGroupItem value="ask">Ask first</ToggleGroupItem>
            <ToggleGroupItem value="off">Off</ToggleGroupItem>
          </ToggleGroup>
          <Switch defaultChecked aria-label="On" />
          <StatusChip tone="proven">Proven</StatusChip>
          <StatusChip tone="attention">Draft</StatusChip>
          <StatusChip tone="broke">Regression</StatusChip>
          <StatusChip tone="signal">Working</StatusChip>
        </div>
      </section>

      <section className="mt-10 flex flex-col gap-5">
        <p className="eyebrow">Tiles · every state</p>
        <div className="flex flex-col gap-6 overflow-x-auto pb-2">
          {STATES.map((state) => (
            <div key={state} className="flex items-start gap-6">
              <span className="w-24 shrink-0 pt-5 font-mono text-[11px] text-ink-3">{state}</span>
              {ENTITIES.map((e) => (
                <Tile
                  key={e.entity}
                  size="sm"
                  tile={{
                    id: e.entity,
                    entity: e.entity,
                    state,
                    label: e.label,
                    ...(e.brand ? { brand: e.brand } : {}),
                    ...(state === "live" ? { caption: "Working…" } : {}),
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="mt-10 flex flex-col gap-3">
        <p className="eyebrow">MiniFlow</p>
        {MINI.map(([label, s]) => (
          <div key={label} className="flex items-center gap-4">
            <MiniFlow proof={proofOf(s)} subject={STACK.dependabot} />
            <span className="text-sm text-ink-2">{label}</span>
          </div>
        ))}
      </section>

      <section className="mt-10 flex flex-col gap-4">
        <p className="eyebrow">Controls</p>
        <div className="flex flex-wrap items-center gap-3">
          <Input placeholder="owner/repo" className="w-56" />
          <Select defaultValue="auto">
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automatic</SelectItem>
              <SelectItem value="ask">Ask first</SelectItem>
              <SelectItem value="off">Off</SelectItem>
            </SelectContent>
          </Select>
          <Tabs defaultValue="findings">
            <TabsList>
              <TabsTrigger value="findings">Findings</TabsTrigger>
              <TabsTrigger value="prs">PRs</TabsTrigger>
              <TabsTrigger value="runs">Runs</TabsTrigger>
            </TabsList>
          </Tabs>
          <Avatar className="size-8">
            <AvatarFallback>TD</AvatarFallback>
          </Avatar>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Repository</TableHead>
              <TableHead>Latest run</TableHead>
              <TableHead className="text-right">PRs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {MINI.slice(0, 3).map(([label, st]) => (
              <TableRow key={label}>
                <TableCell className="font-mono text-xs">teire-dev/examples</TableCell>
                <TableCell>
                  <MiniFlow proof={proofOf(st)} size="xs" />
                </TableCell>
                <TableCell className="text-right font-mono text-xs">2</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex flex-wrap items-center gap-6">
          <Skeleton className="h-8 w-40" />
          <GhostFlow tiles={3} />
        </div>
      </section>

      <section className="mt-10 flex flex-col gap-4">
        <p className="eyebrow">States</p>
        <div className="flex flex-wrap gap-10">
          <BrokenFlow kind="not-found" />
          <BrokenFlow kind="error" />
        </div>
      </section>

      <section className="mt-10 flex items-center gap-3">
        <LogoMark className="size-10" />
        <span className="flex size-10 items-center justify-center rounded-control bg-hero">
          <LogoMark tone="hero" className="size-7" />
        </span>
      </section>
    </div>
  );
}

async function Kit() {
  await connection();
  await requireKit();
  const runs = (await kitRuns()).slice(0, 6);
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-10">
      <header className="flex items-center gap-3">
        <LogoMark className="size-8" />
        <h1 className="heading text-2xl">System</h1>
        <Link href="/kit/cards" className="ml-auto text-sm text-ink-2 hover:text-ink">
          Ask Teire cards ›
        </Link>
      </header>
      <div className="grid gap-6 xl:grid-cols-2">
        <Board />
        <Board dark />
      </div>
      <section className="flex items-center gap-6 rounded-feature bg-sheet p-6 shadow-card sm:p-8">
        <p className="eyebrow">Motion · onboarding's finish</p>
        <LeafBurst />
      </section>
      <section className="flex flex-col gap-10 rounded-feature bg-sheet p-6 shadow-card sm:p-8">
        <p className="eyebrow">Run spine · every state</p>
        {SPINES.map(([label, input]) => (
          <div key={label} className="flex flex-col gap-3 overflow-x-auto">
            <span className="font-mono text-[11px] text-ink-3">{label}</span>
            <StaticFlow size="sm" label={label} graph={runFlow(input)} />
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-10 rounded-feature bg-sheet p-6 shadow-card sm:p-8">
        <p className="eyebrow">Flows · real kit runs</p>
        {runs.map((r) => (
          <StaticFlow
            key={r.id}
            label={`${r.repo}: ${r.groupKey}`}
            graph={proofFlow(r.proof, {
              subject: subjectMark(r.groupKey),
              subjectLabel: r.to
                ? `${(r.groupKey ?? "").split("/").at(-2) ?? ""} → ${r.to}`
                : (r.groupKey ?? ""),
              outcome: r.pr?.kind === "issue" ? "issue" : "pr-ready",
            })}
          />
        ))}
      </section>
    </main>
  );
}
