import { Check, X } from "lucide-react";
import Link from "next/link";
import { MiniFlow } from "@/components/flow/mini-flow";
import { TileSquare } from "@/components/flow/tile";
import { Mark } from "@/components/teire/mark";
import type { Brand } from "@/lib/brands";
import { sourceBrand } from "@/lib/estate";
import type { FlowState } from "@/lib/flow/model";
import { subjectMark } from "@/lib/marks";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { RepoFlow } from "@/lib/workspace";

/**
 * A repository on the Repositories map (plan revision 3.4, V4): where the changes reaching it come
 * from, fanning into the repository, and what Teire has open there; its latest run as a MiniFlow
 * underneath. Drawn on the server: the fan is a fixed SVG, so nothing moves on hydration.
 */
const SHOWN = 3;
const MARK = 24;
const GAP = 8;
const FAN = 40;
const GENERIC: Brand = { label: "Change", light: "/logos/provider.svg", dark: "/logos/provider.svg" };

export function RepoFlowCard({
  fullName,
  state,
  mode,
  live,
  flow,
}: {
  fullName: string;
  state: FlowState;
  /** The fix mode in words, shown only when it isn't Automatic. */
  mode: string | null;
  live: boolean;
  flow: RepoFlow | undefined;
}) {
  const sources = flow?.sources ?? [];
  const shown = sources.slice(0, SHOWN);
  const rows = Math.max(shown.length, 1);
  const h = rows * MARK + (rows - 1) * GAP;
  const outs = [
    {
      n: flow?.ready ?? 0,
      tone: "text-proven",
      glyph: <Check className="size-3" strokeWidth={3} aria-hidden />,
      said: "ready to merge",
    },
    { n: flow?.drafts ?? 0, tone: "text-attention", glyph: <span aria-hidden>◐</span>, said: "drafts" },
    {
      n: flow?.issues ?? 0,
      tone: "text-broke",
      glyph: <X className="size-3" strokeWidth={3} aria-hidden />,
      said: "issues",
    },
  ].filter((o) => o.n);
  const name = fullName.split("/")[1] ?? fullName;
  return (
    <article className="flex flex-col gap-4 rounded-xl bg-sheet p-4 shadow-card transition-shadow hover:shadow-card-hover">
      <header className="flex items-center justify-between gap-2">
        <Link
          href={`/app/repos/${fullName}`}
          className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink hover:underline"
        >
          <span className="truncate">{name}</span>
          {live ? (
            <>
              <span className="size-1.5 shrink-0 rounded-full bg-signal animate-live" aria-hidden />
              <span className="sr-only">Working</span>
            </>
          ) : null}
        </Link>
        {mode ? <span className="shrink-0 font-mono text-[11px] text-ink-3">{mode}</span> : null}
      </header>
      <Link
        href={`/app/repos/${fullName}/findings`}
        className="flex items-center"
        aria-label={`${name}: ${sources.length ? `${sources.reduce((n, s) => n + s.n, 0)} changes reaching it` : "nothing reaching it"}${outs.length ? `, ${outs.map((o) => `${o.n} ${o.said}`).join(", ")}` : ""}`}
      >
        <span className="flex flex-col" style={{ gap: GAP }}>
          {shown.length ? (
            shown.map((s) => {
              const { brand, label } = sourceBrand(s.kind, s.slug);
              return <Mark key={`${s.kind}:${s.slug}`} brand={brand ?? { ...GENERIC, label }} size="sm" />;
            })
          ) : (
            <span className="size-6 rounded-md outline-dashed outline-1 outline-rule-strong -outline-offset-1" />
          )}
        </span>
        <svg
          width={FAN}
          height={h}
          viewBox={`0 0 ${FAN} ${h}`}
          aria-hidden
          className="shrink-0 overflow-visible"
        >
          {Array.from({ length: rows }, (_, i) => {
            const y = i * (MARK + GAP) + MARK / 2;
            return (
              <path
                key={y}
                d={`M0,${y} C${FAN / 2},${y} ${FAN / 2},${h / 2} ${FAN},${h / 2}`}
                fill="none"
                stroke={
                  shown.length ? "color-mix(in oklab, var(--ink) 40%, transparent)" : "var(--rule-strong)"
                }
                strokeWidth={1.5}
                strokeDasharray={shown.length ? undefined : "4 4"}
              />
            );
          })}
        </svg>
        <TileSquare tile={{ entity: "repository", state, label: name }} size="sm" />
        <span
          className={cn(
            "h-px w-6 shrink-0",
            outs.length ? "bg-ink/40" : "border-t border-dashed border-rule-strong",
          )}
        />
        <span className="flex min-w-0 flex-col gap-1 pl-1.5 font-mono text-xs">
          {outs.length ? (
            outs.map((o) => (
              <span key={o.said} className={cn("flex items-center gap-1", o.tone)} title={`${o.n} ${o.said}`}>
                {o.glyph}
                {o.n}
              </span>
            ))
          ) : (
            <span className="text-ink-3">–</span>
          )}
        </span>
        {sources.length > SHOWN ? (
          <span className="ml-auto self-start font-mono text-[11px] text-ink-3">
            +{sources.length - SHOWN}
          </span>
        ) : null}
      </Link>
      <footer className="flex items-center justify-between gap-2 border-t border-rule pt-3">
        {flow?.latest ? (
          <Link
            href={`/runs/${flow.latest.id}`}
            className="flex min-w-0 items-center gap-2"
            title="Its latest run"
          >
            <MiniFlow proof={flow.latest.proof} subject={subjectMark(flow.latest.groupKey)} size="xs" />
          </Link>
        ) : (
          <span className="font-mono text-[11px] text-ink-3">No run yet</span>
        )}
        {flow?.latest ? (
          <span className="font-mono text-[11px] text-ink-3">
            {ago(flow.latest.finishedAt ?? flow.latest.createdAt)}
          </span>
        ) : null}
      </footer>
    </article>
  );
}
