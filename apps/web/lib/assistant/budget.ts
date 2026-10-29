import { assistantCalls, eq, sql, systemState } from "@teire/db";
import { ASSISTANT, DAILY_COST_CAP_DEFAULT_USD, FALLBACK_PRICES } from "@teire/engine/constants";
import { fetchModelPrices, type ModelPrice } from "@teire/engine/llm";
import { database } from "../db";

/**
 * Ask Teire's budget (D127): its own daily caps, per person and across everyone, apart from fix
 * runs, so chatting never stops a fix (`modelWorkBlocked` reads only `llm_calls`). A reply is
 * reserved at an estimate before the model runs, under one lock, so concurrent questions can't all
 * pass a cap that only one of them fits under; the receipt then replaces the estimate with the cost.
 * Token Factory's credit state and the overall daily cap (fixes and chat together) also stop it.
 */
const DAY = sql`now() - interval '24 hours'`;

/** The overall model budget per day, as the worker reads it (its default when unset). */
const OVERALL_CAP_USD = Number(process.env.TEIRE_DAILY_COST_CAP_USD ?? DAILY_COST_CAP_DEFAULT_USD);

export type Reservation = { id: number } | { blocked: string };

/** What a person reads when their own daily allowance is spent (also the kit's notice card). */
export const personBudgetSaid = (allowance: number) =>
  `You've used today's Ask Teire budget ($${allowance.toFixed(2)} a day); it frees up over the next 24 hours.`;

export async function reserve(input: {
  userId: string | null;
  threadId: string;
  model: string;
}): Promise<Reservation> {
  const db = database();
  const who = input.userId ?? "operator";
  const [credits] = await db.select().from(systemState).where(eq(systemState.key, "credits")).limit(1);
  if ((credits?.value as { exhausted?: boolean } | undefined)?.exhausted)
    return { blocked: "Token Factory credits are used up for now, so Nemotron can't answer." };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('teire:assistant-budget'))`);
    const [spent] = (
      await tx.execute<{ mine: string; everyone: string; fixes: string }>(sql`
        select
          coalesce(sum(cost_usd) filter (where user_id = ${who}), 0) as mine,
          coalesce(sum(cost_usd), 0) as everyone,
          (select coalesce(sum(cost_usd), 0) from llm_calls where created_at > ${DAY}) as fixes
        from assistant_calls where created_at > ${DAY} and status <> 'failed'`)
    ).rows;
    const mine = Number(spent?.mine ?? 0);
    const everyone = Number(spent?.everyone ?? 0);
    const fixes = Number(spent?.fixes ?? 0);
    const next = ASSISTANT.estimateUsd;
    const allowance = input.userId === null ? ASSISTANT.operatorDailyUsd : ASSISTANT.perUserDailyUsd;
    if (mine + next > allowance)
      return {
        blocked: personBudgetSaid(allowance),
      };
    if (everyone + next > ASSISTANT.totalDailyUsd)
      return {
        blocked:
          "Ask Teire's budget for today is used up across everyone; it frees up over the next 24 hours.",
      };
    if (OVERALL_CAP_USD > 0 && fixes + everyone + next > OVERALL_CAP_USD)
      return { blocked: "Today's model budget is used up; Teire keeps it for fixes until it frees up." };
    const [row] = await tx
      .insert(assistantCalls)
      .values({
        userId: who,
        threadId: input.threadId,
        model: input.model,
        costUsd: next.toFixed(6),
        status: "reserved",
      })
      .returning({ id: assistantCalls.id });
    return { id: row?.id ?? 0 };
  });
}

/** The reply's receipt: its real tokens and cost, replacing the reservation. */
export async function settle(
  id: number,
  receipt: {
    messageId: string | null;
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    latencyMs: number;
    failed?: boolean;
  },
) {
  await database()
    .update(assistantCalls)
    .set({
      messageId: receipt.messageId,
      model: receipt.model,
      tokensIn: receipt.tokensIn,
      tokensOut: receipt.tokensOut,
      costUsd: receipt.costUsd.toFixed(6),
      latencyMs: receipt.latencyMs,
      status: receipt.failed ? "failed" : "done",
    })
    .where(eq(assistantCalls.id, id));
}

/** Token Factory's public prices, read once an hour per function instance. */
let prices: { at: number; map: Map<string, ModelPrice> } | null = null;

export async function priceOf(model: string): Promise<ModelPrice> {
  if (!prices || Date.now() - prices.at > 3_600_000) {
    // A catalog that can't be read isn't cached as empty: the next reply asks again.
    const map = await fetchModelPrices().catch(() => null);
    if (map?.size) prices = { at: Date.now(), map };
  }
  // Never $0: without the catalog, the last known price, then the recorded fallback, then Ultra's.
  return (
    prices?.map.get(model) ??
    FALLBACK_PRICES[model] ??
    (FALLBACK_PRICES["nvidia/Nemotron-3-Ultra-550b-a55b"] as ModelPrice)
  );
}

/** This person's assistant spend: today's and the last 30 days' (Settings › Usage, the usage tool). */
export async function assistantSpend(userId: string | null) {
  const who = userId ?? "operator";
  const [row] = (
    await database().execute<{ today: string; month: string; replies: number; tokens: string }>(sql`
      select coalesce(sum(cost_usd) filter (where created_at > ${DAY}), 0) as today,
        coalesce(sum(cost_usd), 0) as month, count(*)::int as replies,
        coalesce(sum(tokens_in + tokens_out), 0)::bigint as tokens
      from assistant_calls where user_id = ${who} and created_at > now() - interval '30 days' and status <> 'failed'`)
  ).rows;
  return {
    todayUsd: Number(row?.today ?? 0),
    monthUsd: Number(row?.month ?? 0),
    replies: row?.replies ?? 0,
    tokens: Number(row?.tokens ?? 0),
    dailyCapUsd: ASSISTANT.perUserDailyUsd,
  };
}
