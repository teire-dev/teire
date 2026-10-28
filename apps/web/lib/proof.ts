/**
 * The proof chain (plan revision 3.3, "Signature details"): five steps every run, PR and finding
 * shows, so "the agent finished" and "the fix was proven" never look alike.
 *
 *   CHANGED → REACHES YOUR CODE → FIXED → PROVEN → PR
 *
 * Each step is pending, live (Teire is on it now), done, failed, not proven (it ran, but the evidence
 * doesn't prove it; never shown as failed) or not applicable (a dry run has no PR; a plain bump has
 * no located use).
 */
export type ProofState = "pending" | "live" | "done" | "failed" | "not_proven" | "not_applicable";

export const PROOF_STEPS = [
  { key: "changed", label: "Changed" },
  { key: "reaches", label: "Reaches your code" },
  { key: "fixed", label: "Fixed" },
  { key: "proven", label: "Proven" },
  { key: "pr", label: "PR" },
] as const;

export type ProofStep = (typeof PROOF_STEPS)[number]["key"];

export interface ProofLink {
  state: ProofState;
  /** One line a person reads on hover or in the step's detail ("3 call sites", "70/70 before and after"). */
  detail?: string;
  href?: string;
}

export type Proof = Record<ProofStep, ProofLink>;

/** The glyph for each state, so colour is never the only signal (rows, below 12px). */
export const PROOF_GLYPH: Record<ProofState, string> = {
  done: "✓",
  live: "●",
  pending: "○",
  not_proven: "◐",
  failed: "✕",
  not_applicable: "–",
};

export const PROOF_STATE_LABEL: Record<ProofState, string> = {
  done: "done",
  live: "in progress",
  pending: "not yet",
  not_proven: "not proven",
  failed: "failed",
  not_applicable: "not applicable",
};

/** Evidence kinds that ran but don't prove the change (drafts), and those that count as failing. */
const NOT_PROVEN = new Set([
  "typecheck_only",
  "pre_existing_failure",
  "needs_live_access",
  "needs_local_service",
  "environment_mismatch",
]);
const FAILED = new Set(["regression", "unverified", "timeout"]);

/**
 * Steps a running run reports, in the order they happen, mapped to the chain step they advance. A
 * queued run is on none of them yet: nothing is live until it starts (review round 2). These are
 * the steps the worker and the engine write (`runs.step`, run events).
 */
const STEP_OF: Record<string, ProofStep> = {
  assess: "reaches",
  locate: "reaches",
  notes: "reaches",
  "read-page": "reaches",
  triage: "reaches",
  resolver: "fixed",
  transaction: "fixed",
  codemod: "fixed",
  agent: "fixed",
  fix: "fixed",
  replan: "fixed",
  install: "proven",
  "install-triage": "proven",
  baseline: "proven",
  check: "proven",
  verify: "proven",
  review: "proven",
  pr: "pr",
};

/** What Teire is doing at a step, in the present tense (Factory's grammar), for live rows. */
export const STEP_DOING: Record<string, string> = {
  queue: "Waiting for its turn",
  assess: "Reading the change",
  notes: "Reading the release notes",
  "read-page": "Reading the provider's page",
  triage: "Sorting what reaches the code",
  resolver: "Updating the dependency files",
  transaction: "Applying the change",
  fix: "Applying the change",
  codemod: "Making the deterministic edits",
  agent: "Nemotron is fixing the code",
  replan: "Planning another attempt",
  install: "Installing in the sandbox",
  "install-triage": "Working out why the install failed",
  check: "Running your checks before and after",
  verify: "Weighing the evidence",
  review: "Reviewing the diff",
  pr: "Opening the pull request",
};

export interface RunForProof {
  kind: string;
  status: string;
  step: string | null;
  evidenceKind: string | null;
  prMode: string | null;
  /** Located call sites that reach the run's change; null when the scan didn't look (a plain bump). */
  sites: number | null;
  /** A security advisory: what reaches the code is the installed version, not a call site. */
  advisory?: boolean;
  artifact: { kind: string; url: string | null; number: number | null } | null;
  runHref?: string;
  checks?: string;
}

/** The chain for one run, from the run row, its located sites and what it opened. */
export function proofOfRun(run: RunForProof): Proof {
  const active = run.status === "queued" || run.status === "running" || run.status === "stopping";
  const working = active && run.status !== "queued";
  const at = working ? (STEP_OF[run.step ?? ""] ?? "reaches") : null;
  const order = PROOF_STEPS.map((s) => s.key);
  const before = (step: ProofStep) => at !== null && order.indexOf(step) < order.indexOf(at);
  const progress = (step: ProofStep): ProofState | null =>
    run.status === "queued"
      ? "pending"
      : at === null
        ? null
        : step === at
          ? "live"
          : before(step)
            ? "done"
            : "pending";

  const reaches: ProofLink =
    run.advisory && !run.sites
      ? { state: progress("reaches") ?? "done", detail: "the vulnerable version is installed" }
      : run.sites === null
        ? { state: "not_applicable", detail: "no located use: a plain bump" }
        : run.sites === 0
          ? { state: progress("reaches") ?? "not_applicable", detail: "no call site reaches this change" }
          : {
              state: progress("reaches") ?? "done",
              detail: `${run.sites} call site${run.sites === 1 ? "" : "s"}`,
            };

  const evidence = run.evidenceKind;
  const failedEarly = !active && run.status === "failed" && !evidence;
  const cancelled = !active && run.status === "cancelled" && !evidence;
  // Fixed means a change was committed or proposed (a PR, a draft, a dry run's PR); a run that
  // ended in an issue for a person has none that passed, whatever its evidence (review round 2).
  const fixed: ProofLink = failedEarly
    ? { state: "failed", detail: "stopped before a change was verified" }
    : cancelled
      ? { state: "not_applicable", detail: "cancelled" }
      : (progress("fixed") ?? null) !== null
        ? { state: progress("fixed") as ProofState }
        : run.prMode === "issue" || run.artifact?.kind === "issue"
          ? { state: "failed", detail: "no change passed; a person is needed" }
          : run.prMode === "ready" || run.prMode === "draft" || run.artifact?.kind === "pr"
            ? { state: "done" }
            : { state: "pending" };

  const proven: ProofLink = !evidence
    ? { state: progress("proven") ?? (failedEarly || cancelled ? "not_applicable" : "pending") }
    : evidence === "verified"
      ? { state: "done", ...(run.checks ? { detail: run.checks } : {}) }
      : NOT_PROVEN.has(evidence)
        ? { state: "not_proven", detail: evidence.replace(/_/g, " ") }
        : FAILED.has(evidence)
          ? { state: "failed", detail: evidence.replace(/_/g, " ") }
          : { state: "pending" };

  const pr: ProofLink =
    run.kind === "dry_run"
      ? { state: "not_applicable", detail: "a dry run opens nothing" }
      : run.artifact?.kind === "pr"
        ? {
            state: "done",
            detail: `#${run.artifact.number}${run.prMode === "draft" ? " · draft" : ""}`,
            ...(run.artifact.url ? { href: run.artifact.url } : {}),
          }
        : run.artifact?.kind === "issue"
          ? {
              state: "not_applicable",
              detail: `issue #${run.artifact.number} for a person`,
              ...(run.artifact.url ? { href: run.artifact.url } : {}),
            }
          : { state: progress("pr") ?? (failedEarly || cancelled ? "not_applicable" : "pending") };

  return {
    // The upstream change itself: a run exists only for a change Teire recorded (a release, a
    // retirement), so this step is a fact before the run starts, not something the run did.
    changed: { state: "done", detail: "recorded upstream", ...(run.runHref ? { href: run.runHref } : {}) },
    reaches,
    fixed,
    proven,
    pr,
  };
}
