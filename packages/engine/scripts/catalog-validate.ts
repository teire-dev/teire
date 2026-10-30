/**
 * CI check: the published JSON Schemas are exactly what the zod schemas generate (`--write`
 * regenerates them), and any curated or contributed change record in catalog/changes matches the
 * contract (D72: generated records live in the database, read on demand, D82).
 * Run: pnpm --filter @teire/engine catalog:validate [--write]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { catalogJsonSchemas, providerRecord } from "../src/catalog/schema";
import { changeV2, contractJsonSchemas } from "../src/contract";

const root = resolve(import.meta.dirname, "../../../catalog");
const write = process.argv.includes("--write");
let failures = 0;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".json") ? [path] : [];
  });
}

const problem = (file: string, message: string) => {
  failures++;
  console.error(`${file}: ${message}`);
};
const parse = (file: string) => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    problem(file, `not JSON: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

// Curated providers (C13): each file is one provider record, named after its slug.
for (const file of walk(join(root, "providers"))) {
  const doc = parse(file);
  if (doc === undefined) continue;
  const result = providerRecord.safeParse(doc);
  if (!result.success)
    problem(file, result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
  else if (!file.endsWith(`/${result.data.slug}.json`))
    problem(file, `the file must be named ${result.data.slug}.json`);
}

// Contributed changes (C13): the contract, contributed provenance with who added it, and an id
// that is unique. Valid ones are bundled into catalog/contributed.json, which the worker merges
// on deploy.
const contributed: unknown[] = [];
const ids = new Set<string>();
for (const file of walk(join(root, "changes"))) {
  const doc = parse(file);
  if (doc === undefined) continue;
  const result = changeV2.safeParse(doc);
  if (!result.success) {
    problem(file, result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
    continue;
  }
  const record = result.data;
  if (record.provenance.method !== "catalog") problem(file, 'provenance.method must be "catalog"');
  else if (!record.provenance.contributor)
    problem(file, "provenance.contributor (your GitHub login) is required");
  else if (ids.has(record.id)) problem(file, `the id ${record.id} is used by another record`);
  else if (record.visibility !== "public")
    problem(file, 'a contributed record is public: visibility must be "public"');
  else {
    ids.add(record.id);
    contributed.push(record);
  }
}
const bundlePath = join(root, "contributed.json");
const bundle = contributed.sort((a, b) =>
  String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)),
);
let current: unknown = null;
try {
  current = JSON.parse(readFileSync(bundlePath, "utf8"));
} catch {}
if (JSON.stringify(current) !== JSON.stringify(bundle)) {
  if (write) writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  else problem(bundlePath, "is out of date: run catalog:validate --write");
}

const schemas: Record<string, unknown> = { ...catalogJsonSchemas(), ...contractJsonSchemas() };
for (const [name, schema] of Object.entries(schemas)) {
  const path = join(root, "schema", `${name}.schema.json`);
  const expected = `${JSON.stringify(schema, null, 2)}\n`;
  // Compared as data: Biome formats the committed files, which changes whitespace only.
  let current: unknown = null;
  try {
    current = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  if (JSON.stringify(current) === JSON.stringify(schema)) continue;
  if (write) writeFileSync(path, expected);
  else {
    failures++;
    console.error(`${path} is out of date: run catalog:validate --write`);
  }
}

if (failures) {
  console.error(`${failures} problem(s)`);
  process.exit(1);
}
console.log("catalog ok");
