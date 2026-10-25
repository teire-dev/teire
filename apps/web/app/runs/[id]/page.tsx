import { and, artifacts, asc, eq, llmCalls } from "@teire/db";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { visibleRun } from "@/lib/access";
import { database } from "@/lib/db";
import { Timeline } from "./timeline";

/** One run, live while it works and replayable after (card C9). */
export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-12">
      <Suspense fallback={<p className="text-sm text-foreground/60">Loading the run…</p>}>
        <Run params={params} />
      </Suspense>
    </main>
  );
}

async function Run({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await visibleRun(id);
  if (!row) notFound();
  const { run, repo } = row;
  const db = database();
  const [pr] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.repoId, repo.id), eq(artifacts.runId, run.id)))
    .limit(1);
  const calls = await db
    .select()
    .from(llmCalls)
    .where(eq(llmCalls.runId, run.id))
    .orderBy(asc(llmCalls.createdAt));
  const byModel = new Map<string, { tokensIn: number; tokensOut: number; cost: number; calls: number }>();
  for (const c of calls) {
    const m = byModel.get(c.model) ?? { tokensIn: 0, tokensOut: 0, cost: 0, calls: 0 };
    byModel.set(c.model, {
      tokensIn: m.tokensIn + c.tokensIn,
      tokensOut: m.tokensOut + c.tokensOut,
      cost: m.cost + Number(c.costUsd),
      calls: m.calls + 1,
    });
  }
  const pkg = run.groupKey?.split("/").slice(1, -1).join("/") ?? run.changeId ?? "";
  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="font-mono text-sm text-foreground/60">{repo.fullName}</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {pkg} <span className="font-mono">{run.fromVersion}</span> →{" "}
          <span className="font-mono">{run.targetVersion}</span>
        </h1>
        <p className="text-sm text-foreground/70">
          {run.status}
          {run.evidenceKind ? ` · evidence: ${run.evidenceKind.replace(/_/g, " ")}` : ""}
          {run.backend ? ` · sandbox: ${run.backend}` : ""}
          {pr?.url ? (
            <>
              {" · "}
              <a className="underline" href={pr.url}>
                {pr.kind === "issue" ? "issue" : "pull request"} #{pr.number}
              </a>
            </>
          ) : null}
        </p>
      </header>
      <Timeline runId={run.id} initialStatus={run.status} />
      {byModel.size > 0 && (
        <section aria-label="Receipt" className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Receipt</h2>
          <table className="w-full text-left text-sm">
            <thead className="text-foreground/50">
              <tr>
                <th className="py-1 font-normal">Model</th>
                <th className="py-1 font-normal">Calls</th>
                <th className="py-1 font-normal">Tokens in / out</th>
                <th className="py-1 font-normal">Cost</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {[...byModel].map(([model, m]) => (
                <tr key={model} className="border-t border-foreground/10">
                  <td className="py-1">{model}</td>
                  <td className="py-1">{m.calls}</td>
                  <td className="py-1">
                    {m.tokensIn.toLocaleString()} / {m.tokensOut.toLocaleString()}
                  </td>
                  <td className="py-1">${m.cost.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
