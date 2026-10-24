/**
 * Tells the website to drop cached pages after the worker writes new data (Next Cache Components,
 * tag revalidation; plan D31). Missing configuration is logged, never fatal: pages then refresh on
 * their own cache lifetime.
 */
export async function revalidateWeb(tags: string[]) {
  const base = process.env.TEIRE_WEB_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!base || !secret) {
    console.warn("[web] TEIRE_WEB_URL or REVALIDATE_SECRET not set; skipping revalidation");
    return;
  }
  try {
    const res = await fetch(new URL("/api/revalidate", base), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`[web] revalidate ${tags.join(",")}: ${res.status}`);
  } catch (error) {
    console.warn("[web] revalidate failed", error instanceof Error ? error.message : error);
  }
}
