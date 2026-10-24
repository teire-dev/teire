import { createTokenFactory, fetchModelPrices, ping, tokenFactoryConfigFromEnv } from "@teire/engine";

/**
 * Live check that the hard rule works end to end: one real Nemotron call through Nebius Token Factory.
 * Reports missing configuration plainly instead of pretending.
 */
export async function GET() {
  let config: ReturnType<typeof tokenFactoryConfigFromEnv>;
  try {
    config = tokenFactoryConfigFromEnv();
  } catch (error) {
    return Response.json(
      { ok: false, tokenFactory: { configured: false, error: (error as Error).message } },
      { status: 503 },
    );
  }

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
