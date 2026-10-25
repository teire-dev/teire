import { createTokenFactory, fetchModelPrices, ping, tokenFactoryConfigFromEnv } from "@teire/engine";

/**
 * Health. Public: whether Token Factory is configured, with no model call (the worker's live model
 * state is on /trust). With the operator's bearer (REVALIDATE_SECRET), one real Nemotron call
 * through Nebius Token Factory, so a check cannot be run up by anyone else.
 */
export async function GET(request: Request) {
  let config: ReturnType<typeof tokenFactoryConfigFromEnv>;
  try {
    config = tokenFactoryConfigFromEnv();
  } catch (error) {
    return Response.json(
      { ok: false, tokenFactory: { configured: false, error: (error as Error).message } },
      { status: 503 },
    );
  }
  const secret = process.env.REVALIDATE_SECRET;
  const live = Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
  if (!live) return Response.json({ ok: true, tokenFactory: { configured: true, models: config.models } });

  try {
    const tf = createTokenFactory(config);
    const prices = await fetchModelPrices().catch(() => undefined);
    const result = await ping(tf, "agent", prices);
    return Response.json({ ok: true, tokenFactory: { configured: true, ...result } });
  } catch (error) {
    return Response.json(
      { ok: false, tokenFactory: { configured: true, error: (error as Error).message } },
      { status: 502 },
    );
  }
}
