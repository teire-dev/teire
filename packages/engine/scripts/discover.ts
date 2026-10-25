/**
 * Provider discovery on its own, live: give it what a repo would contain (installed SDKs at exact
 * versions, API URLs from its code) and it prints the providers found with no reader, the notice
 * pages nominated (llms.txt, Tavily), and every record Nemotron 3 Ultra read from them, confirmed or
 * quarantined with the gate's reasons.
 * Run: pnpm --filter @teire/engine exec tsx --env-file=../../.env.local scripts/discover.ts npm:groq-sdk@1.6.0 https://api.mistral.ai/v1/chat/completions
 */
import { ingestProvider, PROVIDERS } from "../src/catalog";
import { discoverProviders, providerCandidates } from "../src/discover";
import { createTokenFactory, fetchModelPrices, tokenFactoryConfigFromEnv } from "../src/llm";
import { memoryCache } from "../src/registry";

const args = process.argv.slice(2);
const urls = args.filter((a) => a.startsWith("https://")).map((u) => new URL(u));
const instances = args
  .filter((a) => /^(npm|pypi):/.test(a))
  .map((a) => {
    const [ecosystem, rest = ""] = a.split(/:(.*)/s) as ["npm" | "pypi", string];
    const at = rest.lastIndexOf("@");
    return {
      ecosystem,
      name: rest.slice(0, at),
      version: rest.slice(at + 1),
      direct: true,
      scope: "prod" as const,
      source: "registry" as const,
    };
  });

const options = { cache: memoryCache() };
const candidates = await providerCandidates({
  urls: urls.map((u) => ({ host: u.hostname, path: u.pathname })),
  instances,
  known: PROVIDERS,
  options,
});
for (const c of candidates)
  console.log(
    `candidate ${c.domain}: hosts ${c.hosts.join(", ")} via ${c.via.join(", ")}; SDK links ${c.sdks.flatMap((s) => s.links).join(", ") || "-"}`,
  );

const found = await discoverProviders(candidates, options);
for (const u of found.usage) console.log(`tavily ${u.endpoint}: ${u.credits} credit(s), ${u.ms} ms`);
for (const n of found.notes) console.log(`note ${n}`);

const reader = { tf: createTokenFactory(tokenFactoryConfigFromEnv()), prices: await fetchModelPrices() };
for (const { provider, via } of found.used) {
  console.log(
    `\n## ${provider.name} (${provider.slug}) via ${via.join(", ")}; official: ${provider.officialDomains.join(", ")}`,
  );
  for (const s of provider.sources) console.log(`   ${s.kind}: ${s.url}`);
  const started = Date.now();
  const run = await ingestProvider(provider, { reader });
  for (const o of run.outcomes)
    console.log(`   fetch ${o.url}: ${o.status}${o.error ? ` (${o.error})` : ""}`);
  for (const r of run.receipts)
    console.log(
      `   read ${r.model}: ${r.tokensIn} in / ${r.tokensOut} out, $${r.costUsd.toFixed(4)}, ${r.ms} ms`,
    );
  for (const t of run.tavily) console.log(`   tavily ${t.endpoint}: ${t.credits} credit(s)`);
  const confirmed = run.records.filter((r) => r.status === "confirmed");
  console.log(
    `   ${run.records.length} records (${confirmed.length} confirmed) in ${Math.round((Date.now() - started) / 1000)} s`,
  );
  for (const r of run.records)
    console.log(
      `   - [${r.status}] ${r.id}: ${r.applicability.class}${r.replacement ? ` → ${r.replacement.value}` : ""}${r.status !== "confirmed" ? ` (${r.quarantineReasons.join("; ")})` : ""}\n       "${r.sources[0]?.quote?.slice(0, 160)}"`,
    );
  for (const d of run.dropped) console.log(`   dropped ${d.subject}: ${d.reason}`);
  for (const r of run.rejected) console.log(`   rejected ${r.id}: ${r.error}`);
}
