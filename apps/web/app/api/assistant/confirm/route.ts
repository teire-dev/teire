import { actionByKey, requestAction } from "@/lib/actions";
import { openProposal } from "@/lib/assistant/proposal";
import { getSession } from "@/lib/session";

/**
 * Confirm on an ActionCard (D119): the person's click, with the token the card was rendered from.
 * Only what the server signed for this person runs, through the same action path as every button
 * (the worker re-checks write access on GitHub). The same proposal confirmed twice is one action.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ ok: false, error: "Sign in to act" }, { status: 401 });
  const { proposal: token } = ((await request.json().catch(() => ({}))) ?? {}) as { proposal?: unknown };
  if (typeof token !== "string" || token.length > 8_000)
    return Response.json({ ok: false, error: "bad request" }, { status: 400 });
  const opened = openProposal(token, session.user.id);
  if ("error" in opened) return Response.json({ ok: false, error: opened.error }, { status: 403 });
  const { proposal, id } = opened;
  const result = await requestAction({
    userId: session.user.id,
    kind: proposal.kind,
    params: proposal.params,
    repo: proposal.repo ?? undefined,
    installationId: proposal.installationId ?? undefined,
    idempotencyKey: `assistant:${id}`,
    source: "assistant",
  });
  return Response.json(result, { status: result.ok ? 200 : 400 });
}

/** Whether a proposal was confirmed already (a reloaded card shows that action instead of Confirm). */
export async function GET(request: Request) {
  const session = await getSession();
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!session || !/^[\w-]{8,64}$/.test(id)) return Response.json({ action: null });
  const action = await actionByKey(session.user.id, `assistant:${id}`);
  return Response.json(
    {
      action: action
        ? { id: action.id, status: action.status, result: action.result, links: action.links }
        : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
