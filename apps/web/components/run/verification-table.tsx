import type { TestCounts } from "@teire/engine/contract";

interface Check {
  name: string;
  argv: string[];
  exitCode: number;
  timedOut: boolean;
  ms: number;
  counts: TestCounts | null;
  output?: string;
}

const cell = (c: Check | undefined) => {
  if (!c) return { text: "—", tone: "text-muted-foreground" };
  if (c.timedOut) return { text: "timed out", tone: "text-affected" };
  const pass = c.exitCode === 0;
  const counts = c.counts ? `${c.counts.passed}/${c.counts.collected}` : pass ? "pass" : `exit ${c.exitCode}`;
  return { text: counts, tone: pass ? "text-clear" : "text-affected" };
};

/** Baseline vs after for every check the repo defines, with the reasons the evidence gives (rule 13). */
export function VerificationTable({
  verification,
}: {
  verification: { baseline?: Check[]; after?: Check[]; reasons?: string[] } | null;
}) {
  if (!verification?.after?.length && !verification?.baseline?.length)
    return <p className="text-sm text-muted-foreground">Nothing has been verified yet.</p>;
  const names = [
    ...new Set([...(verification.baseline ?? []), ...(verification.after ?? [])].map((c) => c.name)),
  ];
  const pick = (side: Check[] | undefined, name: string) => side?.find((c) => c.name === name);
  return (
    <div className="flex flex-col gap-4">
      <table className="w-full overflow-hidden rounded-md font-mono text-xs shadow-card">
        <thead className="bg-muted/60 text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-normal">check</th>
            <th className="px-3 py-2 text-left font-normal">command</th>
            <th className="px-3 py-2 text-right font-normal">baseline</th>
            <th className="px-3 py-2 text-right font-normal">after</th>
          </tr>
        </thead>
        <tbody>
          {names.map((name) => {
            const b = pick(verification.baseline, name);
            const a = pick(verification.after, name);
            const bc = cell(b);
            const ac = cell(a);
            return (
              <tr key={name} className="border-t">
                <td className="px-3 py-2">{name}</td>
                <td className="max-w-[16rem] truncate px-3 py-2 text-muted-foreground">
                  {(a ?? b)?.argv.join(" ")}
                </td>
                <td className={`px-3 py-2 text-right ${bc.tone}`}>{bc.text}</td>
                <td className={`px-3 py-2 text-right ${ac.tone}`}>{ac.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {verification.reasons?.length ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
          {verification.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
