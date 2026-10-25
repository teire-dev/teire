import { JVM } from "../constants";
import { readZip } from "../inventory/zip";
import { guardedFetch } from "../net/fetch";
import type { SurfaceChange } from "./types";

/**
 * The JVM fix agent's `lookup_docs` (plan S08): first the API changes japicmp found that match the
 * query (with what remains: "remaining: transform(…, Executor)", "`toStringHelper` now on
 * MoreObjects", Kotlin's `replaceWith`), then declarations in the target's `-sources.jar` whose
 * name or Javadoc/KDoc matches, shown with that comment and the signature. Read as text only.
 */
async function sources(name: string, version: string) {
  const [group, artifact] = name.split(":") as [string, string];
  for (const base of JVM.mavenMirrors) {
    const host = new URL(base).hostname;
    const res = await guardedFetch(
      `${base}/${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}-sources.jar`,
      { allowHosts: [host], maxBytes: JVM.maxJarBytes, timeoutMs: 120_000 },
    ).catch(() => null);
    if (res?.status === 200)
      return [...readZip(res.body, (n) => /\.(java|kt)$/.test(n)).entries()].map(([path, b]) => ({
        path,
        text: b.toString("utf8"),
      }));
    if (res?.status === 404) return [];
  }
  return [];
}

function declarations(file: { path: string; text: string }) {
  const lines = file.text.split("\n");
  const out: { path: string; line: number; name: string; text: string }[] = [];
  lines.forEach((l, i) => {
    const m =
      /^\s*(?:public|protected)\s[^=;(]*?\b(?:class|interface|enum|record)\s+(\w+)/.exec(l) ??
      /^\s*(?:public|protected)\s[^=;]*?\s(\w+)\s*\(/.exec(l) ??
      /^\s*(?:public\s+|actual\s+|inline\s+|override\s+|open\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.<>?]+\.)?(\w+)\s*\(/.exec(
        l,
      ) ??
      /^\s*(?:public\s+)?(?:data\s+|sealed\s+|abstract\s+|open\s+)*class\s+(\w+)/.exec(l);
    const name = m?.[1];
    if (!name) return;
    let start = i;
    while (start > 0 && /^\s*(?:\*|\/\*\*|\*\/|@)/.test(lines[start - 1] ?? "")) start--;
    out.push({
      path: file.path,
      line: i + 1,
      name,
      text: lines
        .slice(start, i + 1)
        .join("\n")
        .slice(-700),
    });
  });
  return out;
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
  "java",
  "kotlin",
  "version",
  "migration",
  "upgrade",
  "example",
  "method",
  "class",
]);

export function jvmDocsLookup(name: string, version: string, changes: SurfaceChange[]) {
  let loaded: Promise<{ path: string; text: string }[]> | null = null;
  return async (query: string) => {
    loaded ??= sources(name, version).catch(() => []);
    const tokens = [
      ...new Set(
        query
          .split(/[^A-Za-z0-9_]+/)
          .filter(
            (t) =>
              t.length >= 3 &&
              !/^\d/.test(t) &&
              !STOP.has(t.toLowerCase()) &&
              !name.toLowerCase().includes(t.toLowerCase()),
          ),
      ),
    ];
    const lower = tokens.map((t) => t.toLowerCase());
    const score = (text: string) => lower.reduce((n, t) => n + (text.toLowerCase().includes(t) ? 1 : 0), 0);
    const diff = changes
      .map((c) => ({ c, s: score(`${c.path} ${c.guidance ?? ""}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map(
        ({ c }) =>
          `${c.kind} ${c.path}${c.guidance ? ` — ${c.guidance}` : ""}${c.after && c.kind !== "arity-changed" ? ` → ${c.after}` : ""}`,
      );
    const code = (await loaded)
      .flatMap(declarations)
      .map((d) => ({ d, s: (lower.includes(d.name.toLowerCase()) ? 3 : 0) + score(d.text) }))
      .filter((x) => x.s > 1)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map(({ d }) => `${d.path}:${d.line}\n${d.text}`);
    const out = [
      `${name} ${version} for "${query}":`,
      ...(diff.length ? ["API changes from the published jars (japicmp):", ...diff] : []),
      ...(code.length ? ["Declarations in the published sources:", ...code] : []),
    ];
    if (out.length === 1)
      out.push("nothing matches; use the exact class or method names from the compiler output");
    return out.join("\n\n").slice(0, JVM.docsLookupMaxChars);
  };
}
