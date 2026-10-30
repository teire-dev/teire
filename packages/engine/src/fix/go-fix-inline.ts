import { join, normalize, posix } from "node:path";
import { applyPatch, parsePatch } from "diff";
import { VERIFY } from "../constants";

/**
 * `go fix -inline` (S15.4, R21.7): Go ≥1.26 inlines calls to functions a dependency marks
 * `//go:fix inline`, the way the dependency's authors asked. Teire runs it with `-diff` in the
 * sandbox after the install (it needs the installed modules) and keeps only changes that rewrite a
 * call to one of the upgraded module's own inline declarations through that module's import: the
 * analyser may inline another dependency's calls in the same file, and bare `go fix` runs every
 * modernizer.
 */

/** A declaration a module version marks `//go:fix inline`, with the package callers reach it through. */
export interface InlineDirective {
  /** The import path of the package that declares it. */
  pkg: string;
  /** That package's name: what a caller writes when it imports it without an alias. */
  packageName: string;
  name: string;
  /** A method: its receiver can be any value, so its calls can't be told apart by the text alone. */
  method: boolean;
}

const GO_DECLARATION_KEYWORDS = new Set(["func", "const", "type", "var"]);

/** The declarations a module version marks for inlining: a func, a method, a const or a type. */
export function inlineDirectives(
  files: readonly { path: string; text: string }[],
  modulePath: string,
): InlineDirective[] {
  const out: InlineDirective[] = [];
  const re =
    /\/\/go:fix inline[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*(?:func\s+(\([^)]*\)\s*)?|const\s+|type\s+)?(\w+)/g;
  for (const f of files) {
    const packageName = /^package\s+(\w+)/m.exec(f.text)?.[1];
    if (!packageName || packageName === "main") continue;
    const dir = posix.dirname(f.path);
    const pkg = dir === "." ? modulePath : `${modulePath}/${dir}`;
    for (const m of f.text.matchAll(re))
      if (m[2] && !GO_DECLARATION_KEYWORDS.has(m[2]))
        out.push({ pkg, packageName, name: m[2], method: Boolean(m[1]) });
  }
  return out;
}

/** Whether Go source imports the module or one of its packages. */
export function importsModule(source: string, modulePath: string) {
  return importSpecs(source).some((s) => s.path === modulePath || s.path.startsWith(`${modulePath}/`));
}

function importSpecs(source: string) {
  const blocks = [...source.matchAll(/^import\s*(?:\(([\s\S]*?)\)|([^\n]+))/gm)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
  return blocks.flatMap((b) =>
    [...b.matchAll(/(?:^|\n|;)\s*(?:([\w.]+)\s+)?"([^"]+)"/g)].map((m) => ({
      alias: m[1] ?? null,
      path: m[2] ?? "",
    })),
  );
}

/**
 * The names a file reaches each directive's package by: its alias, or the package's own name. A
 * blank or dot import gives none, since a bare call can't be told from a local one.
 */
function localNames(source: string, directives: readonly InlineDirective[]) {
  const names = new Map<string, string>();
  for (const spec of importSpecs(source)) {
    const d = directives.find((x) => x.pkg === spec.path);
    if (!d || spec.alias === "_" || spec.alias === ".") continue;
    names.set(spec.alias ?? d.packageName, spec.path);
  }
  return names;
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

/**
 * The hunks of `go fix -inline -diff` that inline one of the module's own package-level directives,
 * called through the module's import in that file (`alias.Name`). A method's call, a dot import's bare
 * call, or a same-named call through another package goes back to context: the agent sees those.
 */
export function keptInlineEdits(input: {
  diff: string;
  read: (path: string) => string | null;
  projectRoot: string;
  modulePath: string;
  directives: readonly InlineDirective[];
}): { file: string; content: string; line: number; reason: string }[] {
  const out: { file: string; content: string; line: number; reason: string }[] = [];
  const packageLevel = input.directives.filter((d) => !d.method);
  for (const p of parsePatch(input.diff)) {
    const file = repoPathOf(p.oldFileName ?? p.newFileName ?? "", input.projectRoot);
    if (!file) continue;
    const source = input.read(file);
    if (source === null || !importsModule(source, input.modulePath)) continue;
    const locals = [...localNames(source, packageLevel)];
    const calls = (line: string) =>
      packageLevel.flatMap((d) =>
        locals.some(
          ([local, pkg]) =>
            pkg === d.pkg && new RegExp(String.raw`(?<![\w.])${local}\.${d.name}(?!\w)`).test(line),
        )
          ? [d.name]
          : [],
      );
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
