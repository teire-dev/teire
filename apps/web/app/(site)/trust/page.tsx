import { gte, llmCalls, runs, sql, systemState } from "@teire/db";
import { ASSISTANT, DAILY_COST_CAP_DEFAULT_USD } from "@teire/engine/constants";
import {
  Activity,
  Ban,
  Eye,
  FileCheck2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  KeyRound,
  ListChecks,
  type LucideIcon,
  Mail,
  MessageSquareText,
  PiggyBank,
  Quote,
  ShieldCheck,
  Timer,
  UserCheck,
  WifiOff,
} from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { GhostFlow } from "@/components/flow/ghost-flow";
import { StaticFlow } from "@/components/flow/static-flow";
import { SPONSORS, STACK } from "@/lib/brands";
import { database } from "@/lib/db";
import type { FlowGraph } from "@/lib/flow/model";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "How Teire runs",
  description:
    "How Teire runs: the worker's heartbeat, model credits and failover, spend, run outcomes, where your code goes and what Teire may do on GitHub.",
};

/**
 * Teire's live operating state and its standing rules (plan revision 3.4, V5; every line audited
 * against the code in `context/13-design/v5-trust-audit-2026-10-29.md`). Aggregates only: no
 * repository is named here. `#code` and `#permissions` are linked from the landing.
 */
export default function TrustPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 py-12">
      <header className="flex flex-col gap-3">
        <h1 className="display text-5xl text-ink">How Teire runs</h1>
        <p className="font-mono text-xs text-ink-3">
          live state · where code goes · what it may touch · the rules
        </p>
      </header>
      <Suspense
        fallback={
          <div className="flex h-40 items-center justify-center rounded-xl bg-sheet shadow-card">
            <GhostFlow tiles={4} />
          </div>
        }
      >
        <Live />
      </Suspense>
      <Code />
      <Permissions />
      <Rules />
    </main>
  );
}

type Worker = { at: string; version: string };
type Credits = { exhausted: boolean; since: string; detail: string; checkedAt: string };
type Models = { at: string; unhealthy: { model: string; until: string }[] };
type Redelivery = { at: string; failed: number; redelivered: number };

const ago = (iso: string | undefined) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

function Status({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "bad";
  icon: LucideIcon;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl bg-sheet p-4 shadow-card">
      <span className="flex items-center gap-2 text-[13px] text-ink-2">
        <Icon className="size-4 text-ink-3" aria-hidden />
        {label}
        <span
          aria-hidden
          className={cn(
            "ml-auto size-2 rounded-full",
            tone === "bad"
              ? "bg-broke"
              : tone === "warn"
                ? "bg-attention"
                : tone === "ok"
                  ? "bg-proven"
                  : "bg-ink-3",
          )}
        />
      </span>
      <span className="truncate font-mono text-sm text-ink" title={value}>
        {value}
      </span>
    </div>
  );
}

async function Live() {
  // Live state: rendered per request, never at build time.
  await connection();
  const db = database();
  const state = new Map((await db.select().from(systemState)).map((r) => [r.key, r.value]));
  const worker = state.get("worker") as Worker | undefined;
  const credits = state.get("credits") as Credits | undefined;
  const models = state.get("models") as Models | undefined;
  const redelivery = state.get("redelivery") as Redelivery | undefined;
  const day = new Date(Date.now() - 24 * 3600_000);
  const week = new Date(Date.now() - 7 * 24 * 3600_000);
  const [spend] = await db
    .select({
      day: sql<string>`coalesce(sum(${llmCalls.costUsd}) filter (where ${llmCalls.createdAt} >= ${day}), 0)`,
      week: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)`,
    })
    .from(llmCalls)
    .where(gte(llmCalls.createdAt, week));
  const byModel = await db
    .select({
      model: llmCalls.model,
      calls: sql<number>`count(*)::int`,
      cost: sql<string>`sum(${llmCalls.costUsd})`,
    })
    .from(llmCalls)
    .where(gte(llmCalls.createdAt, week))
    .groupBy(llmCalls.model);
  const outcomes = await db
    .select({
      kind: sql<string>`coalesce(${runs.evidenceKind}, ${runs.status})`,
      n: sql<number>`count(*)::int`,
    })
    .from(runs)
    .where(gte(runs.createdAt, week))
    .groupBy(sql`1`);
  const alive = worker && Date.now() - Date.parse(worker.at) < 5 * 60_000;
  const total = outcomes.reduce((n, o) => n + o.n, 0);
  return (
    <section className="flex flex-col gap-3" aria-label="Live state">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Status
          icon={Activity}
          label="Worker"
          value={worker ? `${ago(worker.at)} · ${worker.version.slice(0, 7)}` : "no heartbeat yet"}
          tone={alive ? "ok" : "bad"}
        />
        <Status
          icon={KeyRound}
          label="Model credits"
          value={credits?.exhausted ? `out since ${credits.since.slice(0, 10)}; runs wait` : "available"}
          tone={credits?.exhausted ? "bad" : "ok"}
        />
        <Status
          icon={Timer}
          label="Models"
          value={
            models?.unhealthy?.length
              ? `failover for ${models.unhealthy.map((u) => u.model).join(", ")}`
              : "Nemotron 3 Ultra answering"
          }
          tone={models?.unhealthy?.length ? "warn" : "ok"}
        />
        <Status
          icon={GitPullRequest}
          label="Missed deliveries"
          value={
            redelivery
              ? `${redelivery.failed} failed · ${redelivery.redelivered} redelivered`
              : "not checked yet"
          }
          tone={redelivery?.failed ? "warn" : "ok"}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-[1fr_2fr]">
        <div className="flex flex-col gap-2 rounded-xl bg-sheet p-4 shadow-card">
          <span className="text-[13px] text-ink-2">Model spend</span>
          <span className="font-mono text-[1.75rem] leading-none font-medium text-ink tabular-nums">
            ${Number(spend?.week ?? 0).toFixed(2)}
          </span>
          <span className="font-mono text-[11px] text-ink-3">
            7 days · ${Number(spend?.day ?? 0).toFixed(2)} today · cap ${DAILY_COST_CAP_DEFAULT_USD}/day
          </span>
          <ul className="mt-1 flex flex-col gap-1 font-mono text-[11px] text-ink-2">
            {byModel.map((m) => (
              <li key={m.model} className="flex justify-between gap-2">
                <span className="truncate">{m.model}</span>
                <span className="shrink-0">
                  {m.calls} · ${Number(m.cost).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-3 rounded-xl bg-sheet p-4 shadow-card">
          <span className="text-[13px] text-ink-2">Runs, 7 days · {total}</span>
          {total ? (
            <>
              <div className="flex h-3 overflow-hidden rounded-full bg-sunken" aria-hidden>
                {outcomes.map((o) => (
                  <span
                    key={o.kind}
                    className={OUTCOME_FILL[o.kind] ?? "bg-ink-3/50"}
                    style={{ width: `${(o.n / total) * 100}%` }}
                  />
                ))}
              </div>
              <ul className="flex flex-wrap gap-x-4 gap-y-1.5 font-mono text-[11px] text-ink-2">
                {outcomes.map((o) => (
                  <li key={o.kind} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className={cn("size-2 rounded-full", OUTCOME_FILL[o.kind] ?? "bg-ink-3/50")}
                    />
                    {o.kind.replace(/_/g, " ")} {o.n}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span className="font-mono text-xs text-ink-3">none this week</span>
          )}
        </div>
      </div>
    </section>
  );
}

/** Each outcome in its state's colour: proven green, drafts amber, failures red, the rest quiet. */
const OUTCOME_FILL: Record<string, string> = {
  verified: "bg-proven",
  environment_mismatch: "bg-attention",
  pre_existing_failure: "bg-attention",
  typecheck_only: "bg-attention",
  needs_live_access: "bg-attention",
  needs_local_service: "bg-attention",
  regression: "bg-broke",
  failed: "bg-broke",
  timeout: "bg-broke",
  running: "bg-signal",
  queued: "bg-ink-3/40",
  cancelled: "bg-rule-strong",
};

const tf = {
  label: "Token Factory Sandboxes",
  light: STACK.tokenFactory.light,
  dark: STACK.tokenFactory.dark,
  wide: true,
};

/** The two ways code travels, as flows: public repositories and dry runs, and private repositories. */
const PATHS: { id: string; title: string; graph: FlowGraph }[] = [
  {
    id: "public",
    title: "Public repositories and dry runs",
    graph: {
      tiles: [
        {
          id: "gh",
          entity: "repository",
          state: "done",
          label: "GitHub",
          meta: "tarball, one commit",
          brand: SPONSORS.github,
        },
        {
          id: "sb",
          entity: "sandbox",
          state: "done",
          label: "microVM per command",
          meta: "install: open network",
          brand: tf,
        },
        { id: "chk", entity: "check", state: "proven", label: "Your checks", meta: "network off" },
        { id: "pr", entity: "outcome", state: "done", label: "Pull request", meta: "a person merges" },
      ],
      links: [
        { from: "gh", to: "sb", state: "done" },
        { from: "sb", to: "chk", state: "done" },
        { from: "chk", to: "pr", state: "proven" },
      ],
    },
  },
  {
    id: "private",
    title: "Private repositories",
    graph: {
      tiles: [
        {
          id: "gh",
          entity: "repository",
          state: "done",
          label: "GitHub",
          meta: "fetched by Cloudflare",
          brand: SPONSORS.github,
        },
        {
          id: "sb",
          entity: "sandbox",
          state: "done",
          label: "Container",
          meta: "registries only, GET",
          brand: STACK.cloudflare,
        },
        { id: "chk", entity: "check", state: "proven", label: "Your checks", meta: "network off" },
        { id: "pr", entity: "outcome", state: "done", label: "Pull request", meta: "a person merges" },
      ],
      links: [
        { from: "gh", to: "sb", state: "done" },
        { from: "sb", to: "chk", state: "done" },
        { from: "chk", to: "pr", state: "proven" },
      ],
    },
  },
];

function Code() {
  return (
    <section id="code" className="flex scroll-mt-24 flex-col gap-4">
      <h2 className="heading text-2xl text-ink">Where your code goes</h2>
      {PATHS.map((p) => (
        <div key={p.id} className="flex flex-col gap-3 rounded-xl bg-sheet p-5 shadow-card">
          <span className="text-xs font-medium text-ink-2">{p.title}</span>
          <StaticFlow graph={p.graph} size="sm" label={p.title} />
        </div>
      ))}
      <div className="grid gap-3 md:grid-cols-2">
        <Fact
          brand={STACK.nemotron}
          title="The only model that reads code"
          line="NVIDIA Nemotron 3 Ultra on Nebius Token Factory; Super steps in while Ultra is down. Every call is on its run's receipt."
        />
        <Fact
          brand={STACK.dependabot}
          title="Dependency files"
          line="Decided by Dependabot's updater under gVisor, behind a proxy with a read-only token for that one repository; a few cases (Go majors, renamed packages) use Teire's own step."
        />
        <Fact
          icon={Ban}
          title="No secrets in a sandbox"
          line="GitHub tokens and model keys never enter one. The worker process itself never runs repository code."
        />
        <Fact
          icon={Timer}
          title="What is kept"
          line="A scan deletes its checkout when it ends. Token Factory keeps saved sandbox images of public code for 180 days. Teire keeps findings, proposed diffs, run logs and receipts."
        />
      </div>
    </section>
  );
}

function Fact({
  title,
  line,
  brand,
  icon: Icon,
}: {
  title: string;
  line: string;
  brand?: { label: string; light: string; dark: string; wide?: boolean };
  icon?: LucideIcon;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-sheet p-4 shadow-card">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-sunken">
        {brand ? (
          <BrandLogo
            light={brand.light}
            dark={brand.dark}
            alt=""
            className={cn("w-auto", brand.wide ? "h-3.5 max-w-8" : "h-5 max-w-6")}
          />
        ) : Icon ? (
          <Icon className="size-4 text-ink-2" aria-hidden />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-ink">{title}</span>
        <span className="text-xs text-ink-3">{line}</span>
      </span>
    </div>
  );
}

/** The GitHub App's permissions, exactly the seven `scripts/register-github-app.mjs` asks for. */
const PERMISSIONS: { name: string; level: "read" | "write"; why: string; icon: LucideIcon }[] = [
  {
    name: "Contents",
    level: "write",
    why: "Reads code; pushes only teire/… branches, never the default one.",
    icon: GitBranch,
  },
  {
    name: "Pull requests",
    level: "write",
    why: "Opens and updates fix PRs and Configure Teire.",
    icon: GitPullRequest,
  },
  {
    name: "Issues",
    level: "write",
    why: "The Dashboard issue, issues for a person, @teire replies.",
    icon: MessageSquareText,
  },
  {
    name: "Checks",
    level: "write",
    why: "The Teire check, annotating each line a change reaches.",
    icon: ListChecks,
  },
  {
    name: "Actions",
    level: "read",
    why: "Your CI's logs when it fails on a Teire PR, for one repair.",
    icon: FileCheck2,
  },
  { name: "Metadata", level: "read", why: "Names and default branches; every app needs it.", icon: Eye },
  {
    name: "Email addresses",
    level: "read",
    why: "Names your account at sign-in; never emailed.",
    icon: Mail,
  },
];

function Permissions() {
  return (
    <section id="permissions" className="flex scroll-mt-24 flex-col gap-4">
      <h2 className="heading text-2xl text-ink">What Teire may do on GitHub</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PERMISSIONS.map((p) => (
          <li key={p.name} className="flex items-start gap-3 rounded-xl bg-sheet p-4 shadow-card">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-sunken">
              <p.icon className="size-4 text-ink-2" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-sm font-medium text-ink">
                {p.name}
                <span
                  className={cn(
                    "rounded-full px-1.5 py-px font-mono text-[10px]",
                    p.level === "write" ? "bg-attention-soft text-attention" : "bg-sunken text-ink-3",
                  )}
                >
                  {p.level}
                </span>
              </span>
              <span className="text-xs text-ink-3">{p.why}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The rules every run follows, each one line, each true of the code (see the audit). */
const RULES: { title: string; line: string; icon: LucideIcon }[] = [
  { title: "A person merges", line: "Teire never merges and never deletes a branch.", icon: GitMerge },
  {
    title: "Evidence decides the PR",
    line: "Ready only when the same checks pass before and after; else a draft or an issue.",
    icon: ShieldCheck,
  },
  {
    title: "Quotes or it didn't happen",
    line: "A change is acted on only when its quote matches the fetched page.",
    icon: Quote,
  },
  {
    title: "Offline checks",
    line: "Your checks run with the network off, in both sandboxes.",
    icon: WifiOff,
  },
  {
    title: "Your commits win",
    line: "Push to a Teire branch and Teire stops updating it, and says so.",
    icon: GitBranch,
  },
  {
    title: "Only with write access",
    line: "@teire commands need write access to the repository.",
    icon: UserCheck,
  },
  {
    title: "Private stays private",
    line: "A private repository's runs show only to people GitHub lets see it.",
    icon: Eye,
  },
  {
    title: "Reads what you use",
    line: "Change pages are read for what watched repositories depend on; rescans daily by default and on pushes.",
    icon: Activity,
  },
  {
    title: "Spending stops itself",
    line: `Model work pauses when credits run out or the $${DAILY_COST_CAP_DEFAULT_USD} daily cap is used, and resumes on its own; Ask Teire threads go after ${ASSISTANT.retentionDays} days.`,
    icon: PiggyBank,
  },
];

function Rules() {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="heading text-2xl text-ink">Rules every run follows</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {RULES.map((r) => (
          <li key={r.title} className="flex items-start gap-3 rounded-xl bg-sheet p-4 shadow-card">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-sunken">
              <r.icon className="size-4 text-ink-2" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-ink">{r.title}</span>
              <span className="text-xs text-ink-3">{r.line}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
