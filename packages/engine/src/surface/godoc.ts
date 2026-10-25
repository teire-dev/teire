import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GO } from "../constants";

/**
 * The Go fix agent's `lookup_docs` (plan S05): the target module's own source, as the proxy
 * served it. Exported declarations (funcs, methods, types, consts, vars) with their doc comments,
 * ranked against the query. Each answer cites `module@version/file.go:line`, never a path on this
 * machine: the agent's `read_file` opens only the repository, so the declaration itself is the answer.
 */
export interface GoDecl {
  name: string;
  /** Method receiver type (`*Parser` → `Parser`), when the declaration is a method. */
  receiver: string | null;
  kind: "func" | "method" | "type" | "const" | "var";
  file: string;
  line: number;
  doc: string;
  text: string;
}

const SKIP_DIR = /^(internal|testdata|vendor|examples?|cmd|\..*)$/;

function goFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIR.test(e.name)) out.push(...goFiles(dir, r));
    } else if (e.isFile() && e.name.endsWith(".go") && !e.name.endsWith("_test.go")) out.push(r);
  }
  return out;
}

/** Exported top-level declarations of one Go file, line by line (gofmt'd source is regular). */
export function goDeclarations(source: string, file: string): GoDecl[] {
  const lines = source.split("\n");
  const out: GoDecl[] = [];
  const docAbove = (i: number) => {
    const doc: string[] = [];
    for (let j = i - 1; j >= 0 && /^\s*\/\//.test(lines[j] ?? ""); j--)
      doc.unshift((lines[j] ?? "").replace(/^\s*\/\/ ?/, ""));
    return doc.join(" ").trim();
  };
  const body = (i: number) => {
    const first = lines[i] ?? "";
    if (!/[{(]\s*$/.test(first)) return first;
    const close = first.trimEnd().endsWith("(") ? ")" : "}";
    const taken = [first];
    for (let j = i + 1; j < lines.length && taken.length <= GO.docsBodyLines; j++) {
      taken.push(lines[j] ?? "");
      if ((lines[j] ?? "").startsWith(close)) break;
    }
    if (taken.length > GO.docsBodyLines) taken.push("\t// …");
    return taken.join("\n");
  };
  let group: "const" | "var" | "type" | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (group) {
      if (line.startsWith(")")) {
        group = null;
        continue;
      }
      const m = /^\t([A-Z]\w*)\b/.exec(line);
      if (m?.[1])
        out.push({
          name: m[1],
          receiver: null,
          kind: group,
          file,
          line: i + 1,
          doc: docAbove(i),
          text: line.trim(),
        });
      continue;
    }
    const grouped = /^(const|var|type) \($/.exec(line);
    if (grouped) {
      group = grouped[1] as "const" | "var" | "type";
      continue;
    }
    const fn = /^func (?:\((?:\w+ )?\*?([A-Z]?\w*)(?:\[[^\]]*\])?\) )?([A-Z]\w*)/.exec(line);
    if (fn?.[2]) {
      out.push({
        name: fn[2],
        receiver: fn[1] || null,
        kind: fn[1] ? "method" : "func",
        file,
        line: i + 1,
        doc: docAbove(i),
        text: line.replace(/\s*\{\s*$/, ""),
      });
      continue;
    }
    const decl = /^(type|const|var) ([A-Z]\w*)/.exec(line);
    if (decl?.[2])
      out.push({
        name: decl[2],
        receiver: null,
        kind: decl[1] as GoDecl["kind"],
        file,
        line: i + 1,
        doc: docAbove(i),
        text: body(i),
      });
  }
  // A method of an unexported type is not part of the API a caller can name.
  return out.filter((d) => d.kind !== "method" || /^[A-Z]/.test(d.receiver ?? ""));
}

const STOP = new Set([
  "go",
  "golang",
  "migration",
  "migrate",
  "guide",
  "how",
  "use",
  "new",
  "the",
  "and",
  "for",
  "with",
  "from",
  "func",
  "type",
]);

/** `lookup_docs` for a Go module at its target version, read from `targetDir` (the module cache). */
export function goDocsLookup(modulePath: string, version: string, targetDir: string | null) {
  let decls: GoDecl[] | null = null;
  const load = () => {
    if (decls || !targetDir) return decls;
    decls = goFiles(targetDir).flatMap((f) => {
      try {
        return goDeclarations(
          readFileSync(join(targetDir, f), "utf8"),
          relative(targetDir, join(targetDir, f)),
        );
      } catch {
        return [];
      }
    });
    return decls;
  };
  return async (query: string) => {
    const all = load();
    if (!all)
      return `${modulePath}@${version} is not in the module cache; rely on the quoted migration notes and the compiler's errors.`;
    const pkg =
      modulePath
        .split("/")
        .filter((p) => !/^v\d+$/.test(p))
        .pop()
        ?.toLowerCase() ?? "";
    const words = [
      ...new Set(
        query
          .split(/[^A-Za-z0-9_]+/)
          .filter(
            (t) => t.length >= 2 && !/^\d/.test(t) && t.toLowerCase() !== pkg && !STOP.has(t.toLowerCase()),
          ),
      ),
    ];
    const tokens = words.map((t) => t.toLowerCase());
    const scored = all
      .map((d) => {
        const name = d.name.toLowerCase();
        const recv = d.receiver?.toLowerCase() ?? "";
        let score = 0;
        for (const t of tokens) {
          if (name === t) score += 4;
          else if (recv === t) score += 2;
          else if (t.length >= 4 && (name.includes(t) || d.doc.toLowerCase().includes(t))) score += 1;
        }
        return { d, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.d.name.length - b.d.name.length)
      .slice(0, GO.docsLookupMaxItems);
    const where = (d: GoDecl) => `${modulePath}@${version}/${d.file}:${d.line}`;
    // Only names written as identifiers (`StandardClaims`), not plain words of the question.
    const missing = words.filter((w) => /^[A-Z]/.test(w) && !all.some((d) => d.name === w));
    const parts = [
      `${modulePath} ${version}: exported declarations matching "${query}" (from the module's source; read_file cannot open it, ask again with other names):`,
      ...(scored.length
        ? scored.map(({ d }) => `${d.doc ? `// ${d.doc.slice(0, 300)}\n` : ""}${d.text}\n  (${where(d)})`)
        : ["no exported declaration matches; try the type or function names from the compiler's errors"]),
    ];
    if (missing.length)
      parts.push(
        `Not declared in ${version}: ${missing.join(", ")} (removed or renamed; see the migration notes).`,
      );
    return parts.join("\n\n").slice(0, GO.docsLookupMaxChars);
  };
}
