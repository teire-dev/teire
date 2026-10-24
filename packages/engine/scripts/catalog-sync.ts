/**
 * Reads every provider live and writes the open catalog:
 *   catalog/providers/<slug>.json, catalog/changes/<provider>/<id>.json, catalog/index.json,
 *   catalog/schema/{change,provider}.schema.json
 * Run: pnpm --filter @teire/engine catalog:sync
 * Records are never deleted here: a row a provider later drops stays as history.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ingestProvider } from "../src/catalog/ingest";
import { PROVIDERS } from "../src/catalog/providers";
import { catalogJsonSchemas } from "../src/catalog/schema";

const root = resolve(import.meta.dirname, "../../../catalog");

function write(path: string, value: unknown) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const schemas = catalogJsonSchemas();
write("schema/change.schema.json", schemas.change);
write("schema/provider.schema.json", schemas.provider);

const index: unknown[] = [];
for (const provider of PROVIDERS) {
  write(`providers/${provider.slug}.json`, provider);
  const run = await ingestProvider(provider);
  const failed = run.outcomes.filter((o) => o.status === "failed");
  for (const record of run.records) {
    write(`changes/${provider.slug}/${record.id}.json`, record);
    index.push({
      id: record.id,
      provider: record.provider,
      kind: record.kind,
      title: record.title,
      effectiveOn: record.effectiveOn,
      status: record.status,
    });
  }
  console.log(
    `${provider.slug}: ${run.records.length} records (${run.records.filter((r) => r.status === "quarantined").length} quarantined), ${run.outcomes.length} fetches, ${failed.length} failed`,
  );
  for (const f of failed) console.log(`  failed ${f.url}: ${f.error}`);
}
write("index.json", { generatedAt: new Date().toISOString(), count: index.length, changes: index });
