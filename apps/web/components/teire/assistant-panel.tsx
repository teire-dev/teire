import {
  ArrowUp,
  AtSign,
  Check,
  History,
  PanelRightClose,
  Plus,
  RotateCcw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import Link from "next/link";
import { ProofGlyphs } from "@/components/teire/proof-chain";
import { EvidenceChip } from "@/components/teire/status-chip";
import { Button } from "@/components/ui/button";
import type { Proof } from "@/lib/proof";

export interface AssistantTurn {
  question: string;
  steps: { doing: string; done: string }[];
  answer: string[];
  run?: { id: string; title: string; proof: Proof; evidence: string | null; ledger: string };
  action?: { effect: string; scope: string };
  links: { label: string; href: string }[];
}

/**
 * Ask Teire docked as a right sidebar (plan revision 3.3, "Ask Teire", U4). In U0 it is a composition:
 * the turn shown is assembled from a real run's record, so the layout can be judged with true content;
 * the assistant itself (Nemotron 3 Super, tools, signed proposals) is built in U4.
 */
export function AssistantPanel({ context, turn }: { context: string; turn: AssistantTurn }) {
  return (
    <aside
      aria-label="Ask Teire"
      className="sticky top-12 hidden h-[calc(100svh-3rem)] w-[380px] shrink-0 flex-col border-l border-rule bg-sheet xl:flex"
    >
      <header className="flex items-center gap-2 border-b border-rule px-3 py-2.5">
        <span className="flex size-6 items-center justify-center rounded-md bg-ink text-sheet">
          <Sparkles className="size-3.5" aria-hidden />
        </span>
        <span className="text-sm font-medium text-ink">Ask Teire</span>
        <span className="ml-1 flex min-w-0 items-center gap-1 rounded-full bg-signal-soft px-2 py-0.5 font-mono text-[11px] text-signal">
          <span className="truncate">{context}</span>
          <X className="size-3 shrink-0" aria-label="Remove context" />
        </span>
        <span className="ml-auto flex items-center text-ink-3">
          {[Plus, History, PanelRightClose].map((Icon, i) => (
            <button
              key={Icon.displayName ?? i}
              type="button"
              className="rounded-md p-1.5 hover:bg-hover hover:text-ink"
            >
              <Icon className="size-4" aria-hidden />
            </button>
          ))}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <p className="ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-sunken px-3 py-2 text-sm text-ink ring-1 ring-rule ring-inset">
          {turn.question}
        </p>

        <ul className="flex flex-col gap-1">
          {turn.steps.map((s) => (
            <li key={s.done} className="flex items-center gap-2 font-mono text-[11px] text-ink-3">
              <Check className="size-3 text-ink-2" aria-hidden />
              {s.done}
            </li>
          ))}
        </ul>

        <div className="flex flex-col gap-2.5 text-sm leading-relaxed text-ink">
          {turn.answer.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>

        {turn.run ? (
          <Link
            href={`/kit/run/${turn.run.id}`}
            className="flex flex-col gap-2 rounded-lg bg-sheet p-3 shadow-card hover:shadow-card-hover"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="eyebrow">Run</span>
              <EvidenceChip kind={turn.run.evidence} />
            </span>
            <span className="truncate font-mono text-xs text-ink">{turn.run.title}</span>
            <span className="flex items-center justify-between gap-2">
              <ProofGlyphs proof={turn.run.proof} />
              <span className="font-mono text-[11px] text-ink-3">{turn.run.ledger}</span>
            </span>
          </Link>
        ) : null}

        {turn.action ? (
          <div className="flex flex-col gap-2 rounded-lg bg-sheet p-3 ring-1 ring-signal/40">
            <span className="eyebrow text-signal">Proposed action</span>
            <span className="text-sm text-ink">{turn.action.effect}</span>
            <span className="font-mono text-[11px] text-ink-3">{turn.action.scope}</span>
            <span className="flex gap-2">
              <Button size="sm">Confirm</Button>
              <Button size="sm" variant="ghost">
                Cancel
              </Button>
            </span>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Related</span>
          {turn.links.map((l) => (
            <Link key={l.href} href={l.href} className="entity-link w-fit text-xs text-ink-2">
              {l.label}
            </Link>
          ))}
        </div>
        <span className="flex items-center gap-1 text-ink-3">
          {[ThumbsUp, ThumbsDown, RotateCcw].map((Icon, i) => (
            <button
              key={Icon.displayName ?? i}
              type="button"
              className="rounded-md p-1 hover:bg-hover hover:text-ink"
            >
              <Icon className="size-3.5" aria-hidden />
            </button>
          ))}
        </span>
      </div>

      <footer className="border-t border-rule p-3">
        <div className="flex flex-col gap-2 rounded-lg bg-sunken p-2.5 ring-1 ring-rule ring-inset focus-within:ring-signal">
          <span className="text-sm text-ink-3">Ask about this repository, a run or a change…</span>
          <span className="flex items-center gap-2">
            <AtSign className="size-3.5 text-ink-3" aria-label="Mention a repo, run or change" />
            <span className="font-mono text-[10px] text-ink-3">Nemotron 3 Super · Nebius Token Factory</span>
            <span className="ml-auto flex size-7 items-center justify-center rounded-md bg-ink text-sheet">
              <ArrowUp className="size-4" aria-label="Send" />
            </span>
          </span>
        </div>
      </footer>
    </aside>
  );
}
