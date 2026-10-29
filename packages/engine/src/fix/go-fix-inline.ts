import { join, normalize } from "node:path";
import { applyPatch, parsePatch } from "diff";
import { VERIFY } from "../constants";

/**
 * `go fix -inline` (S15.4, R21.7): Go ≥1.26 inlines calls to functions a dependency marks
 * `//go:fix inline`, the way the dependency's authors asked. Teire runs it with `-diff` in the
 * sandbox after the install (it needs the installed modules) and keeps only hunks that rewrite a
 * call to one of the upgraded module's own inline functions, in files that import that module: the
 * analyser may touch other calls in the same file, and bare `go fix` runs every modernizer.
 */

/** The names a module version marks for inlining: `//go:fix inline` above a func, const or type. */
export function inlineDirectives(files: readonly { path: string; text: string }[]): Set<string> {
  const names = new Set<string>();
  const re =
    /\/\/go:fix inline[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*(?:func\s+(?:\([^)]*\)\s*)?|const\s+|type\s+)(\w+)/g;
  for (const f of files) for (const m of f.text.matchAll(re)) if (m[1]) names.add(m[1]);
  return names;
}

/** Whether Go source imports the module or one of its packages. */
export function importsModule(source: string, modulePath: string) {
  const imports = [...source.matchAll(/^import\s*(?:\(([\s\S]*?)\)|([^\n]+))/gm)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
  return imports.some((block) => block.includes(`"${modulePath}"`) || block.includes(`"${modulePath}/`));
}

/** A path as `go fix -diff` prints it, back to the repository: absolute under the checkout, or relative to the project. */
export function repoPathOf(printed: string, projectRoot: string) {
  const p = printed
    .replace(/^[ab]\//, "")
    .replace(/\s+\((?:old|new)\)$/, "")
    .trim();
  if (p.startsWith(`${VERIFY.workDir}/`)) return p.slice(VERIFY.workDir.length + 1);
  if (p.startsWith("/")) return null;
  return normalize(join(projectRoot === "." ? "" : projectRoot, p));
}

export function keptInlineEdits(input: {
  diff: string;
  read: (path: string) => string | null;
  projectRoot: string;
  modulePath: string;
  names: ReadonlySet<string>;
}): { file: string; content: string; line: number; reason: string }[] {
  const out: { file: string; content: string; line: number; reason: string }[] = [];
  const calls = (line: string) =>
    [...input.names].filter((n) => new RegExp(String.raw`(?:^|[^\w])(?:\w+\.)?${n}\s*\(`).test(line));
  for (const p of parsePatch(input.diff)) {
    const file = repoPathOf(p.oldFileName ?? p.newFileName ?? "", input.projectRoot);
    if (!file) continue;
    const source = input.read(file);
    if (source === null || !importsModule(source, input.modulePath)) continue;
    const used = new Set<string>();
    // Per run of changed lines, not per hunk: a run that doesn't inline one of the module's calls
    // (another dependency's directive in the same hunk) goes back to context.
    const hunks = p.hunks.flatMap((h) => {
      const lines: string[] = [];
      let kept = false;
      for (let i = 0; i < h.lines.length; ) {
        const line = h.lines[i] as string;
        if (!line.startsWith("-") && !line.startsWith("+")) {
          lines.push(line);
          i++;
          continue;
        }
        // One change block: its removed lines, then its added ones; a removed line after an added
        // one starts the next block.
        const run: string[] = [];
        while (i < h.lines.length && (h.lines[i] as string).startsWith("-")) run.push(h.lines[i++] as string);
        while (i < h.lines.length && (h.lines[i] as string).startsWith("+")) run.push(h.lines[i++] as string);
        const named = run.filter((l) => l.startsWith("-")).flatMap((l) => calls(l.slice(1)));
        if (named.length) {
          kept = true;
          for (const n of named) used.add(n);
          lines.push(...run);
        } else lines.push(...run.filter((l) => l.startsWith("-")).map((l) => ` ${l.slice(1)}`));
      }
      if (!kept) return [];
      const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
      return [{ ...h, lines, oldLines: count(/^[ -]/), newLines: count(/^[ +]/) }];
    });
    if (!hunks.length) continue;
    const content = applyPatch(source, { ...p, hunks });
    if (content === false || content === source) continue;
    out.push({
      file,
      content,
      line: hunks[0]?.newStart ?? 1,
      reason: `go fix -inline: ${[...used].join(", ")} inlined as ${input.modulePath} asks`,
    });
  }
  return out;
}
