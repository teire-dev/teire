import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { RUBY } from "../constants";
import { fetchGemLib } from "./ruby";

/**
 * The Ruby fix agent's `lookup_docs` (plan S07): the target gem itself, as published. Its
 * README/UPGRADING/CHANGELOG sections whose text matches the query (upgrade guides say what replaces
 * a removed helper), then the `lib/` definitions whose name or YARD comment matches, shown with
 * that comment and the first lines of the body. Nothing runs; the files are read as text.
 */
interface Doc {
  path: string;
  text: string;
}

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "how",
  "use",
  "api",
  "new",
  "docs",
  "gem",
  "ruby",
  "version",
  "migration",
  "upgrade",
  "example",
]);

async function loadGem(name: string, version: string): Promise<Doc[]> {
  const scratch = await mkdtemp(join(tmpdir(), "teire-gemdoc-"));
  try {
    const lib = await fetchGemLib(name, version, scratch);
    const root = dirname(lib);
    const docs: Doc[] = [];
    for (const entry of await readdir(root)) {
      if (
        !/^(readme|upgrading|migration|changelog|history|changes)[^/]*\.(md|markdown|rdoc|txt)$/i.test(entry)
      )
        continue;
      docs.push({
        path: entry,
        text: (await readFile(join(root, entry), "utf8")).slice(0, RUBY.maxFileBytes),
      });
    }
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".rb") && (await stat(path)).size <= RUBY.maxFileBytes)
          docs.push({ path: relative(root, path), text: await readFile(path, "utf8") });
      }
    };
    await walk(lib).catch(() => {});
    return docs;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Markdown/RDoc sections: a heading line and everything until the next heading. */
function sections(doc: Doc) {
  const out: { path: string; heading: string; body: string }[] = [];
  let heading = "";
  let body: string[] = [];
  const flush = () => {
    if (body.join("").trim()) out.push({ path: doc.path, heading, body: body.join("\n").trim() });
  };
  for (const line of doc.text.split("\n")) {
    if (/^(#{1,6}\s|={1,4}\s)/.test(line)) {
      flush();
      heading = line.trim();
      body = [];
    } else body.push(line);
  }
  flush();
  return out;
}

/** `def`/`class`/`module` lines of a Ruby file with the comment block above and a few body lines. */
function definitions(doc: Doc) {
  const lines = doc.text.split("\n");
  const out: { path: string; line: number; name: string; text: string }[] = [];
  lines.forEach((l, i) => {
    const m = /^\s*(?:def\s+(?:self\.)?([\w?!=]+)|class\s+([\w:]+)|module\s+([\w:]+))/.exec(l);
    const name = m?.[1] ?? m?.[2] ?? m?.[3];
    if (!name) return;
    let start = i;
    while (start > 0 && /^\s*#/.test(lines[start - 1] ?? "")) start--;
    out.push({
      path: doc.path,
      line: i + 1,
      name,
      text: lines.slice(start, Math.min(lines.length, i + 8)).join("\n"),
    });
  });
  return out;
}

export function rubyDocsLookup(
  name: string,
  version: string,
  /** Documents already read for this run (the repo's upgrade guide at the target tag). */
  extra: Doc[] = [],
  load: (n: string, v: string) => Promise<Doc[]> = loadGem,
) {
  let docs: Promise<Doc[]> | null = null;
  return async (query: string) => {
    docs ??= load(name, version).catch(() => []);
    const all = [...extra, ...(await docs)];
    if (!all.length)
      return `The ${name} ${version} gem could not be read; rely on the compiler-like test output and https://www.rubydoc.info/gems/${name}/${version}`;
    const tokens = [
      ...new Set(
        query
          .toLowerCase()
          .split(/[^a-z0-9_?!]+/)
          .filter((t) => t.length >= 3 && !/^\d/.test(t) && t !== name.toLowerCase() && !STOP.has(t)),
      ),
    ];
    const score = (text: string) => tokens.reduce((n, t) => n + (text.toLowerCase().includes(t) ? 1 : 0), 0);
    // Upgrade guides answer "what replaces X" best: they rank above changelog entries.
    const guide = (path: string) => (/upgrad|migrat/i.test(path) ? 2 : 0);
    const prose = all
      .filter((d) => !d.path.endsWith(".rb"))
      .flatMap(sections)
      .map((s) => ({ s, score: score(`${s.heading}\n${s.body}`) * 2 + score(s.heading) + guide(s.path) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ s }) => `${s.path} — ${s.heading}\n${s.body.slice(0, 1000)}`);
    const code = all
      .filter((d) => d.path.endsWith(".rb"))
      .flatMap(definitions)
      .map((d) => ({ d, score: (tokens.includes(d.name.toLowerCase()) ? 3 : 0) + score(d.text) }))
      .filter((x) => x.score > 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ d }) => `${d.path}:${d.line}\n${d.text}`);
    const out = [
      `${name} ${version}, as published (README/UPGRADING/CHANGELOG sections, then lib/ definitions) matching "${query}":`,
      ...prose,
      ...code,
    ];
    if (out.length === 1)
      out.push(
        "nothing in the gem matches; try the exact method or class names from the failing test output",
      );
    return out.join("\n\n").slice(0, RUBY.docsLookupMaxChars);
  };
}
