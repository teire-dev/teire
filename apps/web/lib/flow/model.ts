import type { Brand } from "@/lib/brands";
import { SPONSORS, STACK } from "@/lib/brands";
import { type Proof, type ProofState, proofOfRun, type RunForProof } from "@/lib/proof";

/**
 * The flow vocabulary (plan revision 3.4, A2): one set of tiles and states that every row, card and
 * canvas draws, built from the existing proof model so a row and its canvas never disagree.
 *
 *   change → repository → code → update → fix → sandbox → check → review → outcome
 *
 * `ProofState` stays the source of truth; `FlowState` only adds the visual `proven` (a done Proven
 * step whose evidence is verified) and names `not_applicable` as `skipped`.
 */
export type FlowEntity =
  | "change"
  | "repository"
  | "code"
  | "update"
  | "fix"
  | "sandbox"
  | "check"
  | "review"
  | "outcome";

export type FlowState = "pending" | "live" | "done" | "proven" | "not_proven" | "failed" | "skipped";

export type OutcomeKind = "pr-ready" | "pr-draft" | "issue" | "preview" | "none";

export interface FlowTile {
  id: string;
  entity: FlowEntity;
  state: FlowState;
  /** One to three words under the tile ("Nemotron 3 Ultra", "Your checks"). */
  label: string;
  /** A short figure on the tile's chip ("22 calls", "4/4", "#30"). */
  meta?: string;
  /** The live caption (the present-tense step) or the reason a tile is amber or red. */
  caption?: string;
  brand?: Brand;
  href?: string;
}

export interface FlowLink {
  from: string;
  to: string;
  state: FlowState;
  /** The data the edge carries ("2 call sites", "+8 −8"). */
  label?: string;
}

export interface FlowGraph {
  tiles: FlowTile[];
  links: FlowLink[];
}

/** The run's own step names, mapped to the tile that is live while the step runs. */
export const TILE_OF_STEP: Record<string, FlowEntity> = {
  assess: "code",
  locate: "code",
  notes: "code",
  "read-page": "code",
  triage: "code",
  resolver: "update",
  transaction: "update",
  codemod: "fix",
  agent: "fix",
  fix: "fix",
  replan: "fix",
  install: "sandbox",
  "install-triage": "sandbox",
  baseline: "sandbox",
  check: "check",
  verify: "check",
  review: "review",
  pr: "outcome",
};

export const FLOW_STATE_LABEL: Record<FlowState, string> = {
  pending: "not yet",
  live: "in progress",
  done: "done",
  proven: "proven",
  not_proven: "not proven",
  failed: "failed",
  skipped: "not applicable",
};

/** The glyph on a tile's badge, so colour is never the only signal. */
export const FLOW_GLYPH: Record<FlowState, string> = {
  pending: "○",
  live: "●",
  done: "✓",
  proven: "✓",
  not_proven: "◐",
  failed: "✕",
  skipped: "–",
};

/** A proof detail, cut to tile size (the full sentence stays in the tooltip and the inspector). */
const SHORT: [RegExp, string][] = [
  [/^no located use: a plain bump$/, "plain bump"],
  [/^no call site reaches this change$/, "no call site"],
  [/^the vulnerable version is installed$/, "installed version"],
  [/^stopped before a change was verified$/, "stopped early"],
  [/^no change passed; a person is needed$/, "needs a person"],
  [/^issue (#\d+) for a person$/, "issue $1"],
  [/^a dry run opens nothing$/, "preview"],
  [/^the PR's code, unchanged$/, "PR's code"],
  [/^recorded upstream$/, ""],
];
export function shortDetail(detail: string | undefined) {
  if (!detail) return undefined;
  for (const [re, to] of SHORT) if (re.test(detail)) return detail.replace(re, to) || undefined;
  return detail;
}

export function flowStateOf(state: ProofState, opts: { verified?: boolean } = {}): FlowState {
  if (state === "not_applicable") return "skipped";
  if (state === "done" && opts.verified) return "proven";
  return state;
}

/** The outcome a finished (or finishing) run ends in, from its kind, PR mode and artifact. */
export function outcomeOf(run: Pick<RunForProof, "kind" | "prMode" | "artifact">): OutcomeKind {
  if (run.kind === "dry_run") return "preview";
  if (run.artifact?.kind === "issue" || run.prMode === "issue") return "issue";
  if (run.artifact?.kind === "pr") return run.prMode === "draft" ? "pr-draft" : "pr-ready";
  return "none";
}

export const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  "pr-ready": "Pull request",
  "pr-draft": "Draft PR",
  issue: "Issue",
  preview: "PR preview",
  none: "Pull request",
};

export interface RunFlowInput extends RunForProof {
  /** The change's own mark (provider for models and APIs, ecosystem for packages). */
  subject: Brand;
  /** A short name for the change's tile (`zod`, `gpt-4.1-nano`). */
  subjectLabel: string;
  repo: { fullName: string; avatar?: string };
  /** The Nemotron agent edited code (an `agent` step ran): its calls, and its attempts when known. */
  agent?: { calls: number; attempts?: number } | null;
  /** Deterministic edits ran (a `codemod` step). Neither this nor the agent: no code edits. */
  codemod?: boolean;
  /** The sandbox backend ("tokenfactory" | "cloudflare"). */
  backend?: string | null;
  /** The checks' figure, already formatted ("4/4 → 4/4"), and how many checks ran. */
  checksFigure?: string;
  checks?: string;
  checkCount?: number;
  /** Package changes go through dependabot-core's updater; model and API swaps and re-verifies don't. */
  updater?: boolean;
  /** The last step the run recorded (where a failed or cancelled run stopped). */
  lastStep?: string | null;
  /** A dry run produced its PR as GitHub would show it. */
  preview?: boolean;
}

/**
 * A run as the canonical spine of tiles (the hero, MiniFlow cards and the run canvas start here), each
 * tile's state from where the run is (plan revision 3.4, A2; implementation reviews V0–V3):
 *   queued     the change and the repository are facts; the rest waits;
 *   live       tiles before the live one are done, the live one pulses, the rest wait;
 *   failed     only the tile where it stopped is red (the run's last step); what follows is skipped;
 *              an issue for a person is the outcome, drawn as an issue;
 *   cancelled  where it stopped is skipped with "cancelled";
 *   succeeded  everything done, the checks proven (green) or not proven (amber) by the evidence.
 * Steps that never apply are skipped: no call site, no code edits, no updater for a swap or re-verify.
 */
export function runFlow(input: RunFlowInput): FlowGraph {
  const proof: Proof = proofOfRun(input);
  const verified = input.evidenceKind === "verified";
  const queued = input.status === "queued";
  const active = input.status === "running" || input.status === "stopping";
  const cancelled = input.status === "cancelled";
  const outcome = outcomeOf(input);
  const reverify = input.kind === "reverify";
  const edits = reverify ? "pr" : input.agent ? "agent" : input.codemod ? "codemod" : "none";
  const withUpdater = input.updater !== false && !reverify;

  const sites = input.sites;
  const reach: { state: FlowState; meta?: string } =
    input.advisory && !sites
      ? { state: "done", meta: "installed version" }
      : sites
        ? { state: "done", meta: `${sites} call site${sites === 1 ? "" : "s"}` }
        : { state: "skipped", meta: sites === 0 ? "no call site" : "plain bump" };

  const tiles: FlowTile[] = [
    {
      id: "change",
      entity: "change",
      state: "done",
      label: input.subjectLabel,
      brand: input.subject,
      ...(queued ? { caption: "Queued" } : {}),
    },
    {
      id: "repository",
      entity: "repository",
      state: "done",
      label: input.repo.fullName.split("/")[1] ?? input.repo.fullName,
      meta: input.repo.fullName.split("/")[0],
      brand: SPONSORS.github,
    },
    {
      id: "code",
      entity: "code",
      state: reach.state,
      label: "Your code",
      ...(reach.meta ? { meta: reach.meta } : {}),
    },
    ...(withUpdater
      ? [
          {
            id: "update",
            entity: "update" as const,
            state: "done" as FlowState,
            label: "dependabot-core",
            brand: STACK.dependabot,
          },
        ]
      : []),
    edits === "agent"
      ? {
          id: "fix",
          entity: "fix",
          state: "done",
          label: "Nemotron 3 Ultra",
          brand: STACK.nemotron,
          meta:
            input.agent?.attempts && input.agent.attempts > 1
              ? `${input.agent.attempts} attempts · ${input.agent.calls} calls`
              : `${input.agent?.calls ?? 0} calls`,
        }
      : edits === "codemod"
        ? { id: "fix", entity: "fix", state: "done", label: "Replacement", meta: "$0" }
        : edits === "pr"
          ? { id: "fix", entity: "fix", state: "done", label: "The PR's code", meta: "unchanged" }
          : { id: "fix", entity: "fix", state: "skipped", label: "No code edits" },
    {
      id: "sandbox",
      entity: "sandbox",
      state: "done",
      label: "Sandbox",
      ...(input.backend === "cloudflare"
        ? { brand: STACK.cloudflare, meta: "Cloudflare" }
        : { meta: "Token Factory" }),
    },
    {
      id: "check",
      entity: "check",
      state: verified ? "proven" : "done",
      label: input.checkCount && input.checkCount > 1 ? `${input.checkCount} checks` : "Your checks",
      ...(input.checksFigure ? { meta: input.checksFigure } : {}),
    },
    { id: "review", entity: "review", state: "done", label: "Review" },
    {
      id: "outcome",
      entity: "outcome",
      state: "done",
      label: outcome === "none" ? "Pull request" : OUTCOME_LABEL[outcome],
      ...(shortDetail(proof.pr.detail) && outcome !== "preview"
        ? { meta: shortDetail(proof.pr.detail) as string }
        : {}),
      ...(proof.pr.href ? { href: proof.pr.href } : {}),
    },
  ];
  const at = (id: string) => tiles.findIndex((t) => t.id === id);
  const work = at("code"); // the first tile the run itself does (the change and the repo are facts)
  const set = (i: number, state: FlowState, extra: Partial<FlowTile> = {}) => {
    const t = tiles[i] as FlowTile;
    tiles[i] = { ...t, ...extra, state: t.state === "skipped" && state !== "failed" ? "skipped" : state };
  };
  // Which tile the run is on (live) or stopped at (failed, cancelled).
  const stepTile = (step: string | null | undefined) => {
    const e = TILE_OF_STEP[step ?? ""];
    if (!e) return -1;
    if (e === "update" && !withUpdater) return at("fix");
    return at(e);
  };

  if (queued) {
    for (let i = work; i < tiles.length; i++) set(i, "pending");
  } else if (active) {
    const live = Math.max(stepTile(input.step), work);
    for (let i = work; i < tiles.length; i++) set(i, i < live ? "done" : i === live ? "live" : "pending");
  } else if (cancelled) {
    const stop = Math.max(stepTile(input.lastStep), work);
    for (let i = work; i < tiles.length; i++)
      set(i, i < stop ? "done" : "skipped", i === stop ? { caption: "cancelled" } : {});
    tiles[tiles.length - 1] = {
      ...(tiles.at(-1) as FlowTile),
      state: "skipped",
      label: "Cancelled",
      meta: undefined,
      href: undefined,
    };
  } else if (input.status === "failed" || outcome === "issue") {
    // Where it stopped: the last step it recorded, else the proof's own failed step.
    let stop = stepTile(input.lastStep);
    if (
      stop < work ||
      (tiles[stop] as FlowTile).id === "outcome" ||
      (tiles[stop] as FlowTile).id === "review"
    )
      stop = proof.proven.state === "failed" ? at("check") : at("fix");
    if ((tiles[stop] as FlowTile).id === "fix" && edits === "none" && withUpdater) stop = at("update");
    const why =
      (tiles[stop] as FlowTile).id === "check"
        ? shortDetail(proof.proven.detail)
        : (tiles[stop] as FlowTile).id === "fix" || (tiles[stop] as FlowTile).id === "update"
          ? shortDetail(proof.fixed.detail)
          : undefined;
    for (let i = work; i < tiles.length - 1; i++)
      set(
        i,
        i < stop ? "done" : i === stop ? "failed" : "skipped",
        i === stop && why ? { caption: why } : {},
      );
    const last = tiles.length - 1;
    tiles[last] =
      outcome === "issue"
        ? {
            ...(tiles[last] as FlowTile),
            state: "done",
            label: "Issue",
            meta: shortDetail(proof.pr.detail) ?? "for a person",
          }
        : { ...(tiles[last] as FlowTile), state: "skipped" };
  } else {
    // Succeeded: the evidence colours the checks and the PR.
    const ci = at("check");
    if (proof.proven.state === "not_proven")
      set(ci, "not_proven", { caption: shortDetail(proof.proven.detail) as string });
    const last = tiles.length - 1;
    tiles[last] = {
      ...(tiles[last] as FlowTile),
      state:
        outcome === "preview"
          ? input.preview || verified
            ? "done"
            : "pending"
          : outcome === "pr-draft"
            ? "not_proven"
            : verified
              ? "proven"
              : "done",
    };
  }

  const links: FlowLink[] = tiles.slice(1).map((b, i) => {
    const a = tiles[i] as FlowTile;
    const state: FlowState =
      b.state === "live"
        ? "live"
        : b.state === "pending" || (b.state === "skipped" && a.state !== "done")
          ? "pending"
          : b.state === "failed"
            ? "failed"
            : b.state === "proven" || (a.state === "proven" && b.state !== "skipped")
              ? "proven"
              : b.state === "not_proven"
                ? "not_proven"
                : "done";
    return { from: a.id, to: b.id, state };
  });
  return { tiles, links };
}

/**
 * The five proof steps as tiles, from a proof alone (cards, findings, rows that don't carry the whole
 * run): change → your code → fix → your checks → PR, each with its own detail as the figure.
 */
export function proofFlow(
  proof: Proof,
  opts: { subject?: Brand; subjectLabel: string; outcome?: OutcomeKind },
): FlowGraph {
  const verified = proof.proven.state === "done";
  const steps: { id: string; entity: FlowEntity; key: keyof Proof; label: string; brand?: Brand }[] = [
    {
      id: "change",
      entity: "change",
      key: "changed",
      label: opts.subjectLabel,
      ...(opts.subject ? { brand: opts.subject } : {}),
    },
    { id: "code", entity: "code", key: "reaches", label: "Your code" },
    { id: "fix", entity: "fix", key: "fixed", label: "Fix" },
    { id: "check", entity: "check", key: "proven", label: "Your checks" },
    { id: "outcome", entity: "outcome", key: "pr", label: OUTCOME_LABEL[opts.outcome ?? "pr-ready"] },
  ];
  const tiles: FlowTile[] = steps.map((s) => {
    const link = proof[s.key];
    const state = flowStateOf(link.state, { verified: s.key === "proven" && verified });
    return {
      id: s.id,
      entity: s.entity,
      state,
      label: s.label,
      ...(s.brand ? { brand: s.brand } : {}),
      ...(shortDetail(link.detail) && s.key !== "changed" && !(state === "not_proven" || state === "failed")
        ? { meta: shortDetail(link.detail) as string }
        : {}),
      ...((state === "not_proven" || state === "failed") && shortDetail(link.detail)
        ? { caption: shortDetail(link.detail) as string }
        : {}),
      ...(link.href ? { href: link.href } : {}),
    };
  });
  const links: FlowLink[] = tiles.slice(1).map((t, i) => ({
    from: (tiles[i] as FlowTile).id,
    to: t.id,
    state: t.state === "skipped" ? "pending" : t.state === "proven" ? "proven" : t.state,
  }));
  return { tiles, links };
}
