import { gte, llmCalls, runs, sql, systemState } from "@teire/db";
import { connection } from "next/server";
import { Suspense } from "react";
import { database } from "@/lib/db";

export const metadata = {
  title: "How Teire runs",
  description:
    "How Teire runs: the worker's heartbeat, model credits and failover, spend, run outcomes, and how code and secrets are handled.",
};

/**
 * Teire's live operating state and its standing rules (plan S10, card C12). Aggregates only: no
 * repository is named here.
 */
export default function TrustPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-10 px-4 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">How Teire runs</h1>
        <p className="text-subtle">
          What Teire is doing right now, what it has spent, what it may touch on GitHub, and the rules every
          run follows.
        </p>
      </header>
      <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" aria-hidden />}>
        <Live />
      </Suspense>
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

function Row({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "bad" }) {
  const dot =
    tone === "bad"
      ? "bg-affected"
      : tone === "warn"
        ? "bg-human"
        : tone === "ok"
          ? "bg-clear"
          : "bg-muted-foreground";
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2.5 text-sm last:border-0">
      <span className="flex items-center gap-2 text-muted-foreground">
        <span className={`inline-block size-2 rounded-full ${dot}`} aria-hidden />
        {label}
      </span>
      <span className="text-right font-mono text-xs">{value}</span>
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
  return (
    <>
      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Now</h2>
        <div className="rounded-lg bg-card px-4 py-1 shadow-card">
          <Row
            label="Worker"
            value={
              worker ? `heartbeat ${ago(worker.at)} · ${worker.version.slice(0, 7)}` : "no heartbeat yet"
            }
            tone={alive ? "ok" : "bad"}
          />
          <Row
            label="Model credits (Token Factory)"
            value={
              credits?.exhausted
                ? `exhausted since ${credits.since.slice(0, 16).replace("T", " ")} UTC; runs wait`
                : "available"
            }
            tone={credits?.exhausted ? "bad" : "ok"}
          />
          <Row
            label="Model routing"
            value={
              models?.unhealthy?.length
                ? `failover in use for ${models.unhealthy.map((u) => u.model).join(", ")}`
                : "primary models answering (Nemotron 3 Ultra)"
            }
            tone={models?.unhealthy?.length ? "warn" : "ok"}
          />
          <Row
            label="Missed GitHub deliveries"
            value={
              redelivery
                ? `${redelivery.failed} failed, ${redelivery.redelivered} redelivered (checked ${ago(redelivery.at)})`
                : "not checked yet"
            }
          />
        </div>
      </section>
      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Last 7 days</h2>
        <div className="rounded-lg bg-card px-4 py-1 shadow-card">
          <Row
            label="Model spend"
            value={`$${Number(spend?.day ?? 0).toFixed(2)} today · $${Number(spend?.week ?? 0).toFixed(2)} this week`}
          />
          {byModel.map((m) => (
            <Row key={m.model} label={m.model} value={`${m.calls} call(s) · $${Number(m.cost).toFixed(2)}`} />
          ))}
          {outcomes.length ? (
            outcomes.map((o) => (
              <Row key={o.kind} label={`Runs: ${o.kind.replace(/_/g, " ")}`} value={String(o.n)} />
            ))
          ) : (
            <Row label="Runs" value="none this week" />
          )}
        </div>
      </section>
    </>
  );
}

/** The GitHub App's permissions (scripts/register-github-app.mjs) and why each is asked for. */
const PERMISSIONS: [string, string, string][] = [
  [
    "Contents",
    "write",
    "Read the code and dependency files; push one branch per fix (teire/…). Never the default branch.",
  ],
  ["Pull requests", "write", "Open and update fix PRs, and the Configure Teire onboarding PR."],
  [
    "Issues",
    "write",
    "Keep the Teire Dashboard issue, open needs-a-human issues, and answer @teire commands.",
  ],
  ["Checks", "write", "Publish the Teire check run with an annotation on every line a change reaches."],
  ["Actions", "read", "Read your CI's logs when it fails on a Teire PR, for one repair attempt."],
  ["Metadata", "read", "Repository names and default branches; GitHub requires it for every app."],
  [
    "Email addresses",
    "read",
    "Your account's email when you sign in with GitHub, to name your account; never emailed.",
  ],
];

function Permissions() {
  return (
    <section className="grid gap-6 md:grid-cols-[1fr_1fr]">
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">What Teire may do on GitHub, and why</h2>
        <ul className="divide-y overflow-hidden rounded-lg bg-card text-sm shadow-card">
          {PERMISSIONS.map(([name, level, why]) => (
            <li key={name} className="flex flex-col gap-1 px-4 py-3">
              <span className="flex items-center justify-between gap-3">
                <span className="font-medium">{name}</span>
                <span className="font-mono text-xs text-muted-foreground">{level}</span>
              </span>
              <span className="text-muted-foreground">{why}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Where your code goes</h2>
        <div className="flex flex-col gap-3 rounded-lg bg-card p-4 text-sm text-muted-foreground shadow-card">
          <p>
            <span className="font-medium text-foreground">Models.</span> Only NVIDIA Nemotron on Nebius Token
            Factory reads code: Nemotron 3 Ultra writes fixes, traces model IDs and reads the change pages
            Teire has no parser for, Nemotron 3 Super steps in while Ultra is unavailable. Every call is
            recorded with its tokens and cost: a fix&apos;s calls on its run&apos;s receipt, scan-time
            readings in the spend above.
          </p>
          <p>
            <span className="font-medium text-foreground">Storage.</span> A scan downloads the repository at
            one commit and deletes it when the scan ends. Teire keeps its findings (file, line and the
            matching line), the diffs it proposes, run logs and receipts.
          </p>
          <p>
            <span className="font-medium text-foreground">Instructions.</span> File contents, docs, check
            output and provider pages are data, never instructions: the agent edits only the files the change
            reaches, never manifests, lockfiles, config or CI, and a change is acted on only when its quote
            matches its page.
          </p>
        </div>
      </div>
    </section>
  );
}

function Rules() {
  const rules: [string, string][] = [
    [
      "Reads only what you use",
      "A package's notes and an API's change pages are read only when a watched repository depends on it, then shared and cached. Watched repositories are rescanned daily; nothing is read for a package or provider no watched repository uses.",
    ],
    [
      "Quotes or it did not happen",
      "Every change Teire acts on quotes its source, and the quote is checked against the fetched page before any code changes.",
    ],
    [
      "Your code runs only in a sandbox",
      "Installs, builds and tests run in an isolated container per side (before and after the change). In all six ecosystems, dependency files are updated by Dependabot's updater under gVisor, on a network with no route out except its proxy. The worker never runs repository code.",
    ],
    [
      "Registries only, then offline",
      "During the install the sandbox may read package registries (GET only). Checks run with the network off; any other request is denied and recorded.",
    ],
    [
      "No secrets in the sandbox",
      "GitHub tokens and model keys never enter it; the repository arrives as a tarball the sandbox service fetches itself.",
    ],
    [
      "Evidence decides the PR",
      "A ready PR needs the same checks to pass before and after the change; anything less is a draft that says what was not proven, or an issue for a person.",
    ],
    [
      "Your commits are never overwritten",
      "If someone pushes to a Teire branch, Teire stops updating it and says so.",
    ],
    [
      "Spending stops itself",
      "Model work pauses when Token Factory credits run out or the daily budget is used, and resumes on its own.",
    ],
  ];
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Rules every run follows</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {rules.map(([title, body]) => (
          <li key={title} className="rounded-lg bg-card p-4 shadow-card">
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
