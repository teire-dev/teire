/**
 * CI check: the published JSON Schemas are exactly what the zod schemas generate (`--write`
 * regenerates them), and any curated or contributed change record in catalog/changes matches the
 * contract (D72: generated records live in the database, read on demand, D82).
 * Run: pnpm --filter @teire/engine catalog:validate [--write]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { catalogJsonSchemas } from "../src/catalog/schema";
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

for (const file of walk(join(root, "changes"))) {
  const result = changeV2.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!result.success) {
    failures++;
    console.error(
      `${file}: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
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
