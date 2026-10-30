/**
 * CI check: the published JSON Schemas are exactly what the zod schemas generate (`--write`
 * regenerates them), and any curated or contributed change record in catalog/changes matches the
 * contract (D72: generated records live in the database, read on demand, D82).
 * Run: pnpm --filter @teire/engine catalog:validate [--write]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { quoteAppearsIn } from "../src/catalog/markdown";
import { providerBySlug } from "../src/catalog/providers";
import { catalogJsonSchemas, providerRecord } from "../src/catalog/schema";
import { fetchSource } from "../src/catalog/source";
import { gateV2 } from "../src/catalog/v2";
import { type ChangeV2, changeV2, contractJsonSchemas } from "../src/contract";
import { plainText } from "../src/notes/extract";

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

// Curated providers (C13): each file is one provider record, named after its slug, bundled into
// catalog/providers.json, which the engine loads (a new provider needs no code).
const providers: unknown[] = [];
for (const file of walk(join(root, "providers"))) {
  const doc = parse(file);
  if (doc === undefined) continue;
  const result = providerRecord.safeParse(doc);
  if (!result.success)
    problem(file, result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
  else if (!file.endsWith(`/${result.data.slug}.json`))
    problem(file, `the file must be named ${result.data.slug}.json`);
  else providers.push(doc);
}
const bundled = (path: string, docs: unknown[]) => {
  const sorted = [...docs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  let current: unknown = null;
  try {
    current = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  if (JSON.stringify(current) === JSON.stringify(sorted)) return;
  if (write) writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
  else problem(path, "is out of date: run catalog:validate --write");
};
bundled(join(root, "providers.json"), providers);

// Contributed changes (C13): the contract, contributed provenance with who added it, an id in the
// contributed range (`contrib-…`, never a generated record's: S19 review B2), the file under its
// subject's folder. Valid ones are bundled into catalog/contributed.json, which the worker merges on
// deploy. On a pull request (TEIRE_PR_FILES, from the workflow), each record it adds or changes is
// the PR author's own and passes the quote gate Teire's generated records pass (S19 review B3, B14):
// every source on the provider's own domains, fetched now, its quote really on the page.
const changesDir = join(root, "changes");
const changedInPr = process.env.TEIRE_PR_FILES
  ? new Set(
      process.env.TEIRE_PR_FILES.split("\n")
        .map((f) => f.trim())
        .filter(Boolean),
    )
  : null;
const gateAll = process.argv.includes("--gate");
const contributed: ChangeV2[] = [];
const toGate: { file: string; record: ChangeV2 }[] = [];
const ids = new Set<string>();
for (const file of walk(changesDir)) {
  const doc = parse(file);
  if (doc === undefined) continue;
  const result = changeV2.safeParse(doc);
  if (!result.success) {
    problem(file, result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
    continue;
  }
  const record = result.data;
  const contributor = record.provenance.contributor;
  const folder = record.subject.provider ?? record.subject.name;
  const inPr = changedInPr?.has(relative(resolve(root, ".."), file)) ?? false;
  if (record.provenance.method !== "catalog") problem(file, 'provenance.method must be "catalog"');
  else if (!contributor) problem(file, "provenance.contributor (your GitHub login) is required");
  else if (!record.id.startsWith("contrib-"))
    problem(file, 'a contributed id starts with "contrib-", so it can never be a generated record\'s');
  else if (ids.has(record.id)) problem(file, `the id ${record.id} is used by another record`);
  else if (record.visibility !== "public")
    problem(file, 'a contributed record is public: visibility must be "public"');
  else if (relative(changesDir, file) !== join(folder, `${record.id}.json`))
    problem(file, `the file must be catalog/changes/${folder}/${record.id}.json`);
  else if (
    contributor.pullRequest &&
    !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(contributor.pullRequest)
  )
    problem(file, "provenance.contributor.pullRequest must be a GitHub pull request URL");
  else if (inPr && process.env.TEIRE_PR_AUTHOR && contributor.login !== process.env.TEIRE_PR_AUTHOR)
    problem(
      file,
      `provenance.contributor.login must be the pull request's author, @${process.env.TEIRE_PR_AUTHOR}`,
    );
  else if (inPr && process.env.TEIRE_PR_URL && contributor.pullRequest !== process.env.TEIRE_PR_URL)
    problem(
      file,
      `provenance.contributor.pullRequest must be this pull request, ${process.env.TEIRE_PR_URL}`,
    );
  else {
    ids.add(record.id);
    contributed.push(record);
    if (inPr || gateAll) toGate.push({ file, record });
  }
}
for (const { file, record } of toGate) {
  const bodies = new Map<string, string>();
  const provider = record.subject.provider ? providerBySlug(record.subject.provider) : null;
  // CI fetches only what the gate could accept: https, and on the provider's own domains.
  const fetchable = (url: string) => {
    try {
      const { protocol, hostname } = new URL(url);
      return (
        protocol === "https:" &&
        (!provider || provider.officialDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`)))
      );
    } catch {
      return false;
    }
  };
  for (const source of record.sources) {
    if (!fetchable(source.url)) continue;
    const fetched = await fetchSource(source.url).catch(() => null);
    // The page as text and as served: a quote counts when it is in either.
    if (fetched?.status === "changed")
      bodies.set(source.url, `${plainText(fetched.source.body)}\n${fetched.source.body}`);
  }
  const reasons = provider
    ? gateV2(record, provider, bodies).quarantineReasons.filter((r) => !record.quarantineReasons.includes(r))
    : record.sources.flatMap((s) => {
        const body = bodies.get(s.url);
        return body === undefined
          ? [`Source ${s.url} could not be fetched.`]
          : !s.quote || !quoteAppearsIn(s.quote, body)
            ? [`Quote not found in ${s.url}.`]
            : [];
      });
  if (record.subject.provider && !provider)
    problem(file, `subject.provider ${record.subject.provider} is not a catalog provider`);
  for (const reason of reasons) problem(file, reason);
}
const bundlePath = join(root, "contributed.json");
const bundle = contributed.sort((a, b) => a.id.localeCompare(b.id));
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
