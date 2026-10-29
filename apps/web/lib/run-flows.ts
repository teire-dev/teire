import { artifacts, inArray, llmCalls, runEvents, sql } from "@teire/db";
import type { LedgerCheck } from "@/components/teire/ledger";
import { database } from "./db";
import { type RunFlowInput, TILE_OF_STEP } from "./flow/model";
import { subjectMark, subjectOfKey } from "./marks";
import { reachKey, reachOf } from "./reach";
import { type Scope, scopeRaw } from "./workspace";

/**
 * Many runs as the run page draws them (plan revision 3.4, V4: a PR's breadcrumb trail), in four
 * queries whatever the count: the runs in scope, their reach, their events and their Nemotron calls.
 * Each input is what `runFlow` needs, so a trail and the run canvas never disagree.
 */
type Verification = { baseline?: LedgerCheck[]; after?: LedgerCheck[] } | null;

export async function runFlowsOf(scope: Scope, ids: string[]): Promise<Map<string, RunFlowInput>> {
  const out = new Map<string, RunFlowInput>();
  if (!ids.length) return out;
  const db = database();
  const { rows } = await db.execute<{
    id: string;
    repo_id: number;
    full_name: string;
    group_key: string | null;
    kind: string;
    status: string;
    step: string | null;
    evidence_kind: string | null;
    pr_mode: string | null;
    backend: string | null;
    verification: Verification;
  }>(sql`
    select r.id, r.repo_id, p.full_name, r.group_key, r.kind, r.status, r.step, r.evidence_kind, r.pr_mode,
      r.backend, r.verification
    from runs r join repos p on p.id = r.repo_id join installations i on i.id = p.installation_id
    where ${scopeRaw(scope, "p", "i")} and r.id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
  if (!rows.length) return out;
  const kept = rows.map((r) => r.id);
  const [reach, events, calls, arts] = await Promise.all([
    reachOf(rows.map((r) => ({ repoId: r.repo_id, groupKey: r.group_key }))),
    db
      .select({
        runId: runEvents.runId,
        step: runEvents.step,
        seq: runEvents.seq,
        // A dry run's PR preview, as the run page reads it (a `pr` event of type `dry-run` with a body).
        preview: sql<boolean>`${runEvents.step} = 'pr' and ${runEvents.type} = 'dry-run' and ${runEvents.payload}->>'body' is not null`,
      })
      .from(runEvents)
      .where(inArray(runEvents.runId, kept)),
    db
      .select({
        runId: llmCalls.runId,
        n: sql<number>`count(*)::int`,
        // The agent's attempts: the distinct steps its fix calls ran under, as the run page counts them.
        attempts: sql<number>`count(distinct ${llmCalls.step})::int`,
      })
      .from(llmCalls)
      .where(sql`${inArray(llmCalls.runId, kept)} and ${llmCalls.purpose} = 'fix'`)
      .groupBy(llmCalls.runId),
    db
      .select({ runId: artifacts.runId, kind: artifacts.kind, url: artifacts.url, number: artifacts.number })
      .from(artifacts)
      .where(inArray(artifacts.runId, kept)),
  ]);
  for (const r of rows) {
    const steps = events.filter((e) => e.runId === r.id).sort((a, b) => a.seq - b.seq);
    const { sites, advisory } = reach.get(reachKey(r.repo_id, r.group_key)) ?? {
      sites: null,
      advisory: false,
    };
    const art = arts.find((a) => a.runId === r.id);
    const test = r.verification?.after?.find((c) => c.name === "test")?.counts;
    const before = r.verification?.baseline?.find((c) => c.name === "test")?.counts;
    const agent = steps.some((e) => e.step === "agent");
    out.set(r.id, {
      kind: r.kind,
      status: r.status,
      step: r.step,
      evidenceKind: r.evidence_kind,
      prMode: r.pr_mode,
      sites,
      advisory,
      artifact: art ? { kind: art.kind, url: art.url, number: art.number } : null,
      subject: subjectMark(r.group_key),
      subjectLabel: subjectOfKey(r.group_key ?? "").name || "Change",
      repo: { fullName: r.full_name },
      agent: agent
        ? {
            calls: calls.find((c) => c.runId === r.id)?.n ?? 0,
            attempts: calls.find((c) => c.runId === r.id)?.attempts ?? 0,
          }
        : null,
      codemod: steps.some((e) => e.step === "codemod"),
      backend: r.backend,
      updater: !/^(models|api)\//.test(r.group_key ?? ""),
      lastStep: [...steps].reverse().find((e) => TILE_OF_STEP[e.step])?.step ?? null,
      preview: steps.some((e) => e.preview),
      checkCount: new Set((r.verification?.after ?? []).map((c) => c.name)).size,
      ...(test && before
        ? { checksFigure: `${before.passed}/${before.collected} → ${test.passed}/${test.collected}` }
        : {}),
    });
  }
  return out;
}
