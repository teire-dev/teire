import { connection } from "next/server";
import { Suspense } from "react";
import { LogoMark } from "@/components/logo";
import { assistantTools } from "@/lib/assistant/tools";
import { type Viewer, viewerOfUser } from "@/lib/assistant/viewer";
import { KIT_ACCOUNT, KIT_SCOPE, requireKit } from "@/lib/kit";
import { getSession } from "@/lib/session";
import { KitCard } from "./kit-card";

export const metadata = { title: "Ask Teire cards" };

/**
 * Ask Teire's cards on real data (plan revision 3.4, V6 and B13): each read tool run over the kit's
 * public teire-dev repositories, exactly as the thread calls it, and drawn by the thread's own card.
 * No model is asked, so the board costs nothing and shows every card at once. The one proposal is
 * the signed-in member's own: it acts only if they press Confirm, as in Ask Teire.
 */
export default function KitCardsPage() {
  return (
    <Suspense fallback={<div className="m-8 h-96 shimmer rounded-card" />}>
      <Board />
    </Suspense>
  );
}

// The operator walk's reader: public teire-dev repositories only, never acts.
const READER: Viewer = {
  userId: null,
  name: "kit",
  scope: KIT_SCOPE,
  installationIds: [],
  account: KIT_ACCOUNT,
};

type Tools = ReturnType<typeof assistantTools>;

async function call(tools: Tools, name: keyof Tools, input: Record<string, unknown>) {
  const run = tools[name].execute as unknown as (i: unknown, o: unknown) => Promise<unknown>;
  return { name, input, output: await run(input, { toolCallId: `kit-${name}`, messages: [] }) };
}

const field = <T,>(o: unknown, k: string): T | undefined =>
  o && typeof o === "object" && k in o ? ((o as Record<string, unknown>)[k] as T) : undefined;

async function Board() {
  await connection();
  await requireKit();
  const session = await getSession();
  const read = assistantTools(READER);
  const [overview, repos, runs, changes, usage, docs] = await Promise.all([
    call(read, "get_overview", {}),
    call(read, "list_repos", { filter: "all" }),
    call(read, "list_runs", { which: "recent", limit: 6 }),
    call(read, "list_changes", { query: "" }),
    call(read, "get_usage", {}),
    call(read, "search_docs", { query: "fix mode" }),
  ]);
  // The repository the most changes reach, so its findings, finding and gates all have something.
  const repo = [...(field<{ fullName: string; reaching: number }[]>(repos.output, "repos") ?? [])].sort(
    (a, b) => b.reaching - a.reaching,
  )[0]?.fullName;
  const runId = field<{ id: string }[]>(runs.output, "runs")?.[0]?.id;
  // A dated change if there is one: its card shows the countdown.
  const listed = field<{ id: string; deadline: string | null }[]>(changes.output, "changes") ?? [];
  const changeId = (listed.find((c) => c.deadline) ?? listed[0])?.id;
  const [repoCard, findings, config, run, explained, change, reach] = await Promise.all([
    repo ? call(read, "get_repo", { repo }) : null,
    repo ? call(read, "list_findings", { repo, include: "reaching" }) : null,
    repo ? call(read, "get_config", { repo }) : null,
    runId ? call(read, "get_run", { runId }) : null,
    runId ? call(read, "explain_run", { runId }) : null,
    changeId ? call(read, "get_change", { changeId }) : null,
    changeId ? call(read, "affected_by_change", { changeId }) : null,
  ]);
  const group = field<{ key: string }[]>(findings?.output, "groups")?.[0]?.key;
  const [finding, why] = await Promise.all([
    repo && group ? call(read, "get_finding", { repo, group }) : null,
    repo && group ? call(read, "why_no_pr", { repo, finding: group }) : null,
  ]);
  const act = session ? assistantTools(await viewerOfUser(session.user.id, session.user.name ?? null)) : null;
  const proposal =
    act && repo ? await call(act, "propose_action", { kind: "rescan", repo, params: {} }) : null;
  const refusal = await call(read, "propose_action", { kind: "merge-pr", repo, params: {} });

  const cards = [
    overview,
    repos,
    repoCard,
    findings,
    finding,
    why,
    runs,
    run,
    explained,
    changes,
    change,
    reach,
    config,
    usage,
    docs,
    proposal,
    refusal,
  ].filter((c) => c !== null);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-10">
      <header className="flex items-center gap-3">
        <LogoMark className="size-8" />
        <h1 className="heading text-2xl">Ask Teire cards</h1>
        <span className="ml-auto font-mono text-[11px] text-ink-3">
          {cards.length} cards · real {KIT_ACCOUNT} data · no model call
        </span>
      </header>
      <div className="columns-1 gap-5 md:columns-2">
        {cards.map((c) => (
          <figure
            key={`${c.name}:${JSON.stringify(c.input)}`}
            className="mb-5 flex break-inside-avoid flex-col gap-1.5"
          >
            <figcaption className="font-mono text-[10px] text-ink-3">{c.name}</figcaption>
            {field<string>(c.output, "error") ? (
              <p className="rounded-lg bg-sheet p-3 text-xs text-broke ring-1 ring-rule">
                {field<string>(c.output, "error")}
              </p>
            ) : (
              <KitCard name={c.name} output={c.output} />
            )}
          </figure>
        ))}
      </div>
    </main>
  );
}
