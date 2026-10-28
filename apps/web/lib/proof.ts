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

/** Steps a running run reports, in the order they happen, mapped to the chain step they advance. */
const STEP_OF: Record<string, ProofStep> = {
  queue: "changed",
  assess: "reaches",
  locate: "reaches",
  transaction: "fixed",
  codemod: "fixed",
  agent: "fixed",
  fix: "fixed",
  install: "proven",
  baseline: "proven",
  check: "proven",
  verify: "proven",
  review: "proven",
  pr: "pr",
};

export interface RunForProof {
  kind: string;
  status: string;
  step: string | null;
  evidenceKind: string | null;
  prMode: string | null;
  /** Located call sites for the run's change; null when the scan didn't look (a plain bump). */
  sites: number | null;
  artifact: { kind: string; url: string | null; number: number | null } | null;
  runHref?: string;
  checks?: string;
}

/** The chain for one run, from the run row, its located sites and what it opened. */
export function proofOfRun(run: RunForProof): Proof {
  const active = run.status === "queued" || run.status === "running" || run.status === "stopping";
  const at = active ? (STEP_OF[run.step ?? "queue"] ?? "changed") : null;
  const order = PROOF_STEPS.map((s) => s.key);
  const before = (step: ProofStep) => at !== null && order.indexOf(step) < order.indexOf(at);
  const progress = (step: ProofStep): ProofState | null =>
    at === null ? null : step === at ? "live" : before(step) ? "done" : "pending";

  const reaches: ProofLink =
    run.sites === null
      ? { state: "not_applicable", detail: "no located use: a plain bump" }
      : run.sites === 0
        ? { state: progress("reaches") ?? "not_applicable", detail: "no call site reaches this change" }
        : {
            state: progress("reaches") ?? "done",
            detail: `${run.sites} call site${run.sites === 1 ? "" : "s"}`,
          };

  const evidence = run.evidenceKind;
  const failedEarly = !active && run.status === "failed" && !evidence;
  const fixed: ProofLink = failedEarly
    ? { state: "failed", detail: "stopped before a change was verified" }
    : { state: progress("fixed") ?? (evidence ? "done" : "pending") };

  const proven: ProofLink = !evidence
    ? { state: progress("proven") ?? (failedEarly ? "not_applicable" : "pending") }
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
          : { state: progress("pr") ?? (failedEarly ? "not_applicable" : "pending") };

  return {
    changed: { state: "done", ...(run.runHref ? { href: run.runHref } : {}) },
    reaches,
    fixed,
    proven,
    pr,
  };
}
