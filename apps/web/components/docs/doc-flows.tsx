import { SPONSORS, STACK, TEIRE } from "@/lib/brands";
import type { FlowGraph, FlowLink, FlowTile } from "@/lib/flow/model";

/**
 * The docs' architecture diagrams as live flows (plan revision 3.4, V6 and B12): the same tiles and
 * connectors the app draws, from the facts in `.github/diagrams/*.mmd` (the README keeps the Mermaid).
 * A diagram is one or more lanes, each a left-to-right flow with its own title.
 */
export interface DocLane {
  title: string;
  graph: FlowGraph;
}

/** Tiles joined in order; `labels[i]` is the edge into tile i + 1. */
function lane(title: string, tiles: FlowTile[], labels: (string | undefined)[] = []): DocLane {
  const links: FlowLink[] = tiles.slice(1).map((t, i) => ({
    from: tiles[i]?.id as string,
    to: t.id,
    state: t.state === "pending" ? "pending" : t.state === "proven" ? "proven" : "done",
    ...(labels[i] ? { label: labels[i] } : {}),
  }));
  return { title, graph: { tiles, links } };
}

export const DOC_FLOWS: Record<string, DocLane[]> = {
  "fix-loop": [
    lane(
      "Checks pass after the upgrade",
      [
        { id: "c", entity: "change", state: "done", label: "A change", meta: "reaches your code" },
        {
          id: "u",
          entity: "update",
          state: "done",
          label: "Upgrade",
          meta: "manifest + lockfile",
          brand: STACK.dependabot,
        },
        { id: "e", entity: "fix", state: "done", label: "Deterministic edits", meta: "swaps · renames" },
        { id: "k", entity: "check", state: "proven", label: "Your checks", meta: "before vs after" },
        { id: "p", entity: "outcome", state: "proven", label: "Pull request", meta: "ready" },
      ],
      [undefined, undefined, "sandbox", "pass"],
    ),
    lane(
      "Checks fail: Nemotron fixes what broke",
      [
        { id: "k", entity: "check", state: "failed", label: "Your checks", meta: "fail" },
        {
          id: "a",
          entity: "fix",
          state: "done",
          label: "Nemotron 3 Ultra",
          meta: "≤4 attempts · 24 steps",
          caption: "a fresh plan after 2",
          brand: STACK.nemotron,
        },
        { id: "k2", entity: "check", state: "proven", label: "Checks again", meta: "pass" },
        { id: "r", entity: "review", state: "done", label: "Review pass", meta: "tests kept" },
        {
          id: "p",
          entity: "outcome",
          state: "done",
          label: "Pull request",
          meta: "ready · draft · issue",
          caption: "the evidence decides",
        },
      ],
      ["edits", "loops", "once more if not", undefined],
    ),
  ],
  dashboard: [
    lane(
      "From the Overview to a pull request",
      [
        { id: "o", entity: "review", state: "done", label: "Overview", meta: "what needs you", brand: TEIRE },
        { id: "e", entity: "change", state: "done", label: "Your estate", meta: "drag a change" },
        { id: "r", entity: "repository", state: "done", label: "A repository", meta: "its findings" },
        { id: "f", entity: "fix", state: "done", label: "Fix now", meta: "one click" },
        { id: "k", entity: "check", state: "proven", label: "The run", meta: "before → after" },
        { id: "p", entity: "outcome", state: "done", label: "Pull request", meta: "you merge it" },
      ],
      ["pick one", "open it", "start", "the evidence", undefined],
    ),
  ],
  "ask-teire": [
    lane(
      "Ask, read, draw, confirm",
      [
        { id: "q", entity: "review", state: "done", label: "You ask", meta: "⌘I · @mentions" },
        {
          id: "n",
          entity: "fix",
          state: "done",
          label: "Nemotron 3 Ultra",
          meta: "Token Factory",
          brand: STACK.nemotron,
        },
        { id: "t", entity: "code", state: "done", label: "Teire's records", meta: "only what you can see" },
        { id: "c", entity: "check", state: "proven", label: "Cards", meta: "flows · figures" },
        { id: "a", entity: "outcome", state: "pending", label: "Confirm", meta: "your click" },
      ],
      ["plain words", "read tools", "the real rows", "to act"],
    ),
  ],
  commands: [
    lane(
      "One comment, one answer",
      [
        {
          id: "c",
          entity: "review",
          state: "done",
          label: "@teire fix zod",
          meta: "a comment",
          brand: SPONSORS.github,
        },
        { id: "e", entity: "check", state: "done", label: "👀", meta: "read at once" },
        { id: "w", entity: "check", state: "proven", label: "Write access", meta: "checked on GitHub" },
        { id: "r", entity: "fix", state: "done", label: "The run", meta: "live on its page" },
        { id: "a", entity: "outcome", state: "done", label: "A reply", meta: "with the run's link" },
      ],
      ["seconds", "or refused", "starts", "in the thread"],
    ),
  ],
  "five-steps": [
    lane(
      "Every run takes five steps",
      [
        { id: "n", entity: "change", state: "done", label: "Notice", meta: "registries · OSV" },
        { id: "i", entity: "code", state: "done", label: "Impact", meta: "the exact lines" },
        {
          id: "f",
          entity: "fix",
          state: "done",
          label: "Fix",
          meta: "swap or Nemotron",
          brand: STACK.nemotron,
        },
        { id: "v", entity: "sandbox", state: "proven", label: "Verify", meta: "network off" },
        { id: "p", entity: "outcome", state: "proven", label: "Pull request", meta: "quotes · receipt" },
      ],
      ["your deps", "call sites", "checks", "evidence"],
    ),
  ],
  quickstart: [
    lane(
      "Install to first pull request",
      [
        {
          id: "i",
          entity: "repository",
          state: "done",
          label: "Install",
          meta: "pick repos",
          brand: SPONSORS.github,
        },
        { id: "s", entity: "review", state: "done", label: "First scan", meta: "every manifest" },
        { id: "c", entity: "outcome", state: "done", label: "Configure Teire", meta: "a PR with teire.yml" },
        { id: "a", entity: "fix", state: "done", label: "Fix runs", meta: "urgent first" },
        {
          id: "p",
          entity: "outcome",
          state: "proven",
          label: "Pull requests",
          meta: "ready · draft · issue",
        },
      ],
      ["minutes", "no teire.yml", "you merge", "≤5 open"],
    ),
  ],
  "public-scan": [
    lane(
      "No install, nothing written to GitHub",
      [
        {
          id: "u",
          entity: "repository",
          state: "done",
          label: "owner/name",
          meta: "any public repo",
          brand: SPONSORS.github,
        },
        { id: "s", entity: "review", state: "done", label: "Scan", meta: "1–5 minutes" },
        { id: "r", entity: "code", state: "done", label: "The report", meta: "lines at one commit" },
        {
          id: "d",
          entity: "sandbox",
          state: "proven",
          label: "Dry run",
          meta: "one change",
          brand: STACK.tokenFactory,
        },
        { id: "p", entity: "outcome", state: "done", label: "PR preview", meta: "never opened" },
      ],
      ["3 a day", "the lines", "1 a day", "a preview"],
    ),
  ],
  configuration: [
    lane(
      "A key, from the file to the next scan",
      [
        { id: "f", entity: "update", state: "done", label: ".github/teire.yml", meta: "optional" },
        { id: "k", entity: "check", state: "proven", label: "Schema", meta: "a mistake → its default" },
        {
          id: "o",
          entity: "repository",
          state: "done",
          label: "Organisation",
          meta: "teire-config defaults",
        },
        { id: "s", entity: "review", state: "done", label: "Next scan", meta: "reads it" },
      ],
      ["checked", "fills the gaps", "every key resolved"],
    ),
  ],
  system: [
    lane(
      "Events in",
      [
        {
          id: "gh",
          entity: "repository",
          state: "done",
          label: "GitHub",
          meta: "webhooks",
          brand: SPONSORS.github,
        },
        { id: "web", entity: "review", state: "done", label: "Web app", meta: "Vercel", brand: TEIRE },
        { id: "db", entity: "check", state: "done", label: "Postgres", meta: "outbox · Coolify" },
        { id: "wk", entity: "fix", state: "done", label: "Worker", meta: "Coolify", brand: TEIRE },
      ],
      ["push · install", "outbox + NOTIFY", "claimed"],
    ),
    lane(
      "A run",
      [
        { id: "wk", entity: "fix", state: "done", label: "Worker", brand: TEIRE },
        {
          id: "pages",
          entity: "change",
          state: "done",
          label: "Change pages",
          meta: "registries · OSV · Tavily",
        },
        {
          id: "tf",
          entity: "fix",
          state: "done",
          label: "Nemotron 3 Ultra",
          meta: "Token Factory",
          brand: STACK.nemotron,
        },
        {
          id: "up",
          entity: "update",
          state: "done",
          label: "dependabot-core",
          meta: "gVisor",
          brand: STACK.dependabot,
        },
        {
          id: "sb",
          entity: "sandbox",
          state: "done",
          label: "Sandboxes",
          meta: "Token Factory · Cloudflare",
          brand: STACK.tokenFactory,
        },
        {
          id: "out",
          entity: "outcome",
          state: "proven",
          label: "Pull request",
          meta: "check run · issue",
          brand: SPONSORS.github,
        },
      ],
      ["quotes", "fix", "upgrade", "checks", "PR"],
    ),
    lane(
      "You",
      [
        { id: "dev", entity: "repository", state: "done", label: "You", meta: "install the App" },
        {
          id: "web",
          entity: "review",
          state: "done",
          label: "Dashboard",
          meta: "scan · catalog · docs",
          brand: TEIRE,
        },
        { id: "cli", entity: "code", state: "done", label: "CLI and MCP", meta: "coding agents" },
      ],
      ["sign in", "the public catalog"],
    ),
  ],
  "model-retirement": [
    lane(
      "Groq shuts two Llama models down on 2026-08-16",
      [
        {
          id: "r",
          entity: "repository",
          state: "done",
          label: "wrapped-models",
          meta: "groq-sdk",
          brand: SPONSORS.github,
        },
        { id: "w", entity: "change", state: "done", label: "Groq's page", meta: "via the SDK + Tavily" },
        {
          id: "n",
          entity: "review",
          state: "proven",
          label: "Read with quotes",
          meta: "2 shutdowns kept",
          brand: STACK.nemotron,
        },
      ],
      ["fetched", "verbatim"],
    ),
    lane(
      "Teire traces them to the request and fixes both",
      [
        { id: "c", entity: "code", state: "done", label: "src/llm.ts:12", meta: "a tier registry" },
        { id: "f", entity: "fix", state: "done", label: "1 swap · 1 picked", meta: "Teire · Nemotron" },
        { id: "s", entity: "sandbox", state: "proven", label: "Your checks", meta: "0/4 → 4/4" },
        { id: "p", entity: "outcome", state: "proven", label: "Ready PR", meta: "quotes · receipt" },
      ],
      [undefined, "tsc · vitest", "Verified."],
    ),
  ],
  "build-webhook": [
    lane(
      "From GitHub to the worker",
      [
        {
          id: "gh",
          entity: "repository",
          state: "done",
          label: "GitHub",
          meta: "signed",
          brand: SPONSORS.github,
        },
        { id: "web", entity: "review", state: "done", label: "Webhook", meta: "answers 202", brand: TEIRE },
        { id: "db", entity: "check", state: "done", label: "Outbox", meta: "stored once" },
        { id: "wk", entity: "fix", state: "done", label: "Worker", meta: "claims 10", brand: TEIRE },
        { id: "q", entity: "outcome", state: "done", label: "Queues", meta: "one per repo" },
      ],
      ["POST", "by ID", "NOTIFY", "pg-boss"],
    ),
  ],
  "sandbox-image": [
    lane(
      "A public run on Token Factory Sandboxes",
      [
        {
          id: "img",
          entity: "sandbox",
          state: "done",
          label: "Image",
          meta: "built once",
          caption: "by recipe hash",
          brand: STACK.tokenFactory,
        },
        { id: "co", entity: "code", state: "done", label: "Checkout", meta: "≤200 MB" },
        { id: "in", entity: "update", state: "done", label: "Install", meta: "network on" },
        { id: "ck", entity: "check", state: "proven", label: "Checks", meta: "no network" },
      ],
      ["kept microVM", "new image", "chained"],
    ),
  ],
};
