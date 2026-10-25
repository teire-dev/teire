/**
 * Reads every provider live and writes the open catalog:
 *   catalog/providers/<slug>.json, catalog/changes/<provider>/<id>.json, catalog/index.json,
 *   catalog/schema/*.schema.json (provider, change-v2, dependency-instance)
 * Run: pnpm --filter @teire/engine catalog:sync
 * Records are never deleted here: a row a provider later drops stays as history.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ingestProvider } from "../src/catalog/ingest";
import { PROVIDERS } from "../src/catalog/providers";
import { catalogJsonSchemas, changeRecord } from "../src/catalog/schema";
import { toChangeV2 } from "../src/catalog/v2";
import { changeV2, contractJsonSchemas } from "../src/contract";

const root = resolve(import.meta.dirname, "../../../catalog");

function write(path: string, value: unknown) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const schemas = { ...catalogJsonSchemas(), ...contractJsonSchemas() };
for (const [name, schema] of Object.entries(schemas)) write(`schema/${name}.schema.json`, schema);

const index: unknown[] = [];
for (const provider of PROVIDERS) {
  write(`providers/${provider.slug}.json`, provider);
  const run = await ingestProvider(provider);
  const fresh = new Set(run.records.map((r) => r.id));
  const failed = run.outcomes.filter((o) => o.status === "failed");
  for (const record of run.records) {
    write(`changes/${provider.slug}/${record.id}.json`, record);
    index.push({
      id: record.id,
      provider: record.subject.provider,
      subject: record.subject,
      kind: record.kind,
      class: record.applicability.class,
      title: record.title,
      effectiveOn: record.applicability.effectiveOn,
      status: record.status,
    });
  }
  console.log(
    `${provider.slug}: ${run.records.length} records (${run.records.filter((r) => r.status === "quarantined").length} quarantined), ${run.outcomes.length} fetches, ${failed.length} failed`,
  );
  for (const f of failed) console.log(`  failed ${f.url}: ${f.error}`);
  for (const r of run.rejected) console.log(`  rejected ${r.id}: ${r.error}`);
  // History the provider no longer lists stays; schema-v1 files are converted in place (they were
  // gated when written, so their status stands).
  const dir = join(root, "changes", provider.slug);
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const old = JSON.parse(readFileSync(join(dir, name), "utf8")) as { schemaVersion: number; id: string };
    if (fresh.has(old.id)) continue;
    const record =
      old.schemaVersion === 1 ? toChangeV2(changeRecord.parse(old), provider) : changeV2.parse(old);
    write(`changes/${provider.slug}/${name}`, record);
    index.push({
      id: record.id,
      provider: record.subject.provider,
      subject: record.subject,
      kind: record.kind,
      class: record.applicability.class,
      title: record.title,
      effectiveOn: record.applicability.effectiveOn,
      status: record.status,
    });
    console.log(`  kept ${record.id} (no longer listed)`);
  }
}
write("index.json", { generatedAt: new Date().toISOString(), count: index.length, changes: index });
