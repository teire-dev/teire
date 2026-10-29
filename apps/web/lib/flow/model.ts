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
  /** `zod 3.25.76 → 4.6.6` or `gpt-4.1-nano → gpt-5.6-luna`. */
  subjectLabel: string;
  repo: { fullName: string; avatar?: string };
  /** Whether the Nemotron agent edited code (an `agent` step ran), or a replacement did. */
  agent?: { calls: number; attempts?: number } | null;
  /** The sandbox backend, for its mark ("tokenfactory" | "cloudflare"). */
  backend?: string | null;
  /** The checks' figures, already formatted ("4/4 → 4/4"). */
  checksFigure?: string;
  updater?: boolean;
}

/**
 * A run as the canonical spine of tiles (the hero, MiniFlow and the run canvas start from this).
 * The proof chain decides each tile's state; the live step picks the one live tile.
 */
export function runFlow(input: RunFlowInput): FlowGraph {
  const proof: Proof = proofOfRun(input);
  const verified = input.evidenceKind === "verified";
  const active = input.status === "running" || input.status === "stopping";
  const liveEntity = active ? (TILE_OF_STEP[input.step ?? ""] ?? null) : null;
  const outcome = outcomeOf(input);

  const reach = flowStateOf(proof.reaches.state);
  const fixed = flowStateOf(proof.fixed.state);
  const proven = flowStateOf(proof.proven.state, { verified });
  const pr = flowStateOf(proof.pr.state);
  // Within a proof step, the tile Teire is on is live; tiles before it in the same step are done.
  const within = (entity: FlowEntity, order: FlowEntity[], stepState: FlowState): FlowState => {
    if (!liveEntity || !order.includes(liveEntity)) return stepState;
    const at = order.indexOf(liveEntity);
    const me = order.indexOf(entity);
    return me < at ? "done" : me === at ? "live" : "pending";
  };

  const sandboxBrand = input.backend === "cloudflare" ? STACK.cloudflare : STACK.tokenFactory;
  const tiles: FlowTile[] = [
    { id: "change", entity: "change", state: "done", label: input.subjectLabel, brand: input.subject },
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
      state: reach,
      label: "Your code",
      ...(shortDetail(proof.reaches.detail) ? { meta: shortDetail(proof.reaches.detail) as string } : {}),
    },
    ...(input.updater === false
      ? []
      : [
          {
            id: "update",
            entity: "update" as const,
            state: within("update", ["update", "fix"], fixed),
            label: "dependabot-core",
            brand: STACK.dependabot,
          },
        ]),
    {
      id: "fix",
      entity: "fix",
      state: within("fix", ["update", "fix"], fixed),
      label: input.agent ? "Nemotron 3 Ultra" : "Replacement",
      ...(input.agent ? { brand: STACK.nemotron, meta: `${input.agent.calls} calls` } : { meta: "$0" }),
    },
    {
      id: "sandbox",
      entity: "sandbox",
      state: within("sandbox", ["sandbox", "check", "review"], proven === "proven" ? "done" : proven),
      label: input.backend === "cloudflare" ? "Cloudflare" : "Sandbox",
      brand: sandboxBrand,
    },
    {
      id: "check",
      entity: "check",
      state: within("check", ["sandbox", "check", "review"], proven),
      label: "Your checks",
      ...(input.checksFigure ? { meta: input.checksFigure } : {}),
      ...(proof.proven.state === "not_proven" || proof.proven.state === "failed"
        ? { caption: shortDetail(proof.proven.detail) as string }
        : {}),
    },
    {
      id: "outcome",
      entity: "outcome",
      state: outcome === "preview" ? (proven === "proven" ? "done" : "pending") : pr,
      label: OUTCOME_LABEL[outcome],
      ...(shortDetail(proof.pr.detail) && outcome !== "preview"
        ? { meta: shortDetail(proof.pr.detail) as string }
        : {}),
      ...(proof.pr.href ? { href: proof.pr.href } : {}),
    },
  ];
  const ids = tiles.map((t) => t.id);
  const links: FlowLink[] = ids.slice(1).map((to, i) => {
    const from = ids[i] as string;
    const a = tiles[i] as FlowTile;
    const b = tiles[i + 1] as FlowTile;
    const state: FlowState =
      b.state === "live"
        ? "live"
        : b.state === "pending" || b.state === "skipped"
          ? "pending"
          : b.state === "failed"
            ? "failed"
            : b.state === "proven" || (a.state === "proven" && b.entity === "outcome")
              ? "proven"
              : "done";
    return { from, to, state };
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
