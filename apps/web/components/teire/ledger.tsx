import type { TestCounts } from "@teire/engine/contract";
import { EvidenceChip, StatusChip } from "@/components/teire/status-chip";
import { cn } from "@/lib/utils";

export interface LedgerCheck {
  name: string;
  argv: string[];
  exitCode: number;
  timedOut: boolean;
  ms: number;
  counts: TestCounts | null;
  output?: string;
}

type Cell = { text: string; glyph: string; tone: string };

function cell(c: LedgerCheck | undefined): Cell {
  if (!c) return { text: "not run", glyph: "–", tone: "text-ink-3" };
  if (c.timedOut) return { text: "timed out", glyph: "✕", tone: "text-broke" };
  const pass = c.exitCode === 0;
  const text = c.counts ? `${c.counts.passed}/${c.counts.collected}` : pass ? "pass" : `exit ${c.exitCode}`;
  return { text, glyph: pass ? "✓" : "✕", tone: pass ? "text-ink" : "text-broke" };
}

const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

/**
 * The proof panel (plan revision 3.3, signature detail 2): every check the repository defines, before
 * and after, in mono figures; each row opens its own output. It closes on the verdict and on what the
 * checks did not cover (Devin's honesty pattern). It is the same table the PR's Verification shows.
 */
export function Ledger({
  baseline,
  after,
  evidence,
  verdict,
  notCovered,
  live = false,
  className,
}: {
  baseline: LedgerCheck[];
  after: LedgerCheck[];
  evidence: string | null;
  verdict?: string;
  notCovered: string[];
  /** The run is still checking: rows fill as each check finishes; no verdict or coverage yet. */
  live?: boolean;
  className?: string;
}) {
  const names = [...new Set([...baseline, ...after].map((c) => c.name))];
  const pick = (side: LedgerCheck[], name: string) => side.find((c) => c.name === name);
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 border-b border-rule px-4 pb-2">
        <span className="eyebrow">Check</span>
        <span className="eyebrow w-16 text-right">Before</span>
        <span className="eyebrow w-16 text-right">After</span>
      </div>
      {names.length === 0 ? (
        <p className="px-4 py-6 text-xs text-ink-3">No check has run yet.</p>
      ) : (
        <ul className="divide-y divide-rule">
          {names.map((name) => {
            const b = pick(baseline, name);
            const a = pick(after, name);
            const before = cell(b);
            const now = cell(a);
            const output = (a?.output || b?.output || "").trim();
            return (
              <li key={name}>
                <details className="group">
                  <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 px-4 py-2.5 hover:bg-hover [&::-webkit-details-marker]:hidden">
                    <span className="flex min-w-0 flex-col">
                      <span className="font-mono text-xs text-ink">{name}</span>
                      <span className="truncate font-mono text-[11px] text-ink-3">
                        {(a ?? b)?.argv.join(" ")}
                        {a ? ` · ${seconds(a.ms)}` : ""}
                      </span>
                    </span>
                    <Figure cell={before} />
                    <Figure cell={now} />
                  </summary>
                  <pre className="mx-4 mb-3 max-h-64 overflow-auto rounded-md bg-sunken p-3 font-mono text-[11px] leading-relaxed text-ink-2 ring-1 ring-rule ring-inset">
                    {output || "No output was kept for this check."}
                  </pre>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-col gap-2 border-t border-rule px-4 pt-3">
        {live ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
            <StatusChip tone="signal">Checking</StatusChip>
            Each check shows as it finishes; the verdict comes when both sides are done.
          </p>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
              <EvidenceChip kind={evidence} />
              {verdict ? <span className="font-mono">{verdict}</span> : null}
            </p>
            <p className="text-xs text-ink-3">
              <span className="eyebrow mr-1.5">Not covered</span>
              {notCovered.length ? notCovered.join("; ") : "nothing the checks report as skipped"}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Figure({ cell: c }: { cell: Cell }) {
  return (
    <span className={cn("flex w-16 items-center justify-end gap-1 font-mono text-xs tabular-nums", c.tone)}>
      <span aria-hidden className="text-[10px]">
        {c.glyph}
      </span>
      {c.text}
    </span>
  );
}

/** What a run's checks did not cover, read from the checks themselves (no model involved). */
export function notCoveredFrom(baseline: LedgerCheck[], after: LedgerCheck[], reasons: string[] = []) {
  const out: string[] = [];
  const all = [...baseline, ...after];
  if (!all.some((c) => c.name === "test")) out.push("no test command was found");
  const skipped = after.find((c) => c.name === "test")?.counts;
  if (skipped) {
    const rest = skipped.collected - skipped.passed - skipped.failed;
    if (rest > 0) out.push(`${rest} test${rest === 1 ? "" : "s"} skipped`);
  }
  for (const r of reasons)
    if (/not (run|covered|checked)|skipped|without|no (test|baseline)/i.test(r)) out.push(r);
  return [...new Set(out)];
}
