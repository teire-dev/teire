import type { RepoTree } from "../inventory/tree";
import type { SurfaceChange } from "../surface/types";
import type { Hit, LocateResult } from "./ts";

/**
 * Exact JVM sites (plan S08, research jvm.md Job 5): the references `teire-jvm refs` read from the
 * repo's own compiled classes on the baseline, as javac/kotlinc resolved them, matched to the
 * diff's keys. A removed overload matches only calls whose descriptor has its parameter types (the
 * overloads that remain do not break); a `kotlin:` key matches only calls from Kotlin sources.
 * Misses what bytecode cannot show: inlined constants and Kotlin `inline` function bodies.
 */
const PRIMITIVE: Record<string, string> = {
  Z: "boolean",
  B: "byte",
  C: "char",
  S: "short",
  I: "int",
  J: "long",
  F: "float",
  D: "double",
  V: "void",
};

/** `(Ljava/lang/String;[I)V` → ["String", "int[]"] (java.lang. dropped, as the diff writes them). */
export function descriptorParams(desc: string) {
  const inner = /^\(([^)]*)\)/.exec(desc)?.[1] ?? "";
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    let dims = 0;
    while (inner[i] === "[") {
      dims++;
      i++;
    }
    let type: string;
    if (inner[i] === "L") {
      const end = inner.indexOf(";", i);
      type = inner.slice(i + 1, end).replace(/\//g, ".");
      i = end + 1;
    } else {
      type = PRIMITIVE[inner[i] as string] ?? "?";
      i++;
    }
    out.push(type.replace(/^java\.lang\./, "") + "[]".repeat(dims));
  }
  return out;
}

/** Parameter lists of removed overloads per key, from the diff (`Futures.transform(A, B)` → [[A, B]]). */
export function removedOverloads(changes: SurfaceChange[]) {
  const out = new Map<string, string[][]>();
  for (const c of changes) {
    if (c.kind !== "arity-changed" || !c.declKey) continue;
    const inside = /\(([^)]*)\)\s*$/.exec(c.before ?? c.path)?.[1]?.trim() ?? "";
    // Inner classes print with `.` in the diff and with `$` in bytecode: compare simple names.
    const params = inside ? inside.split(/\s*,\s*/) : [];
    out.set(c.declKey, [...(out.get(c.declKey) ?? []), params]);
  }
  return out;
}

const simple = (t: string) => t.replace(/\$/g, ".");

export function locateBytecode(input: {
  probe: string;
  tree: RepoTree;
  declKeys: ReadonlySet<string>;
  overloads?: ReadonlyMap<string, string[][]>;
  /**
   * The library's packages (`com.google.common`) and the project folder: a source file there that
   * uses them but compiled to no class (another source set, an Android variant, a failed build) is
   * an unresolved site (S19).
   */
  packages?: string[];
  projectRoot?: string;
}): LocateResult {
  const started = Date.now();
  const files = input.tree.files();
  const fileFor = new Map<string, string | null>();
  const resolve = (cls: string, src: string) => {
    const key = `${cls}|${src}`;
    if (!fileFor.has(key)) {
      const dir = cls.includes("/") ? cls.slice(0, cls.lastIndexOf("/")) : "";
      const suffix = dir ? `${dir}/${src}` : src;
      const found = files.filter((f) => f === suffix || f.endsWith(`/${suffix}`));
      fileFor.set(key, found.find((f) => !/\/(test|androidTest)\//.test(f)) ?? found[0] ?? null);
    }
    return fileFor.get(key) ?? null;
  };
  const lineText = (file: string, line: number) => (input.tree.read(file) ?? "").split("\n")[line - 1] ?? "";
  const hits: Hit[] = [];
  let unresolved = 0;
  // The source files that compiled, from TeireRefs' one "class" row per scanned class.
  const compiled = new Set<string>();
  let classRows = 0;
  // Classes compiled without a SourceFile attribute (`javac -g:none`): their uses can't be placed,
  // so they're counted, never read as no use (S19 review B10).
  let sourceless = 0;
  for (const row of input.probe.split("\n")) {
    const [cls, src, lineText0, kind, ownerInternal, member, desc] = row.split("\t");
    if (cls && kind === "class") {
      if (!src) {
        sourceless++;
        continue;
      }
      classRows++;
      const file = resolve(cls, src);
      if (file) compiled.add(file);
      continue;
    }
    if (!cls || !kind || !ownerInternal) continue;
    const owner = ownerInternal.replace(/\//g, ".");
    const kotlin = !!src?.endsWith(".kt");
    const memberKey = member ? `${owner}#${member}` : null;
    const candidates = [
      ...(memberKey ? [memberKey] : []),
      ...(memberKey && kotlin ? [`kotlin:${memberKey}`] : []),
      // A companion's members are keyed on the class (`HttpUrl.parse`).
      ...(memberKey && /\$Companion#/.test(memberKey)
        ? [`kotlin:${memberKey.replace("$Companion#", "#")}`]
        : []),
      owner,
    ];
    const declKey = candidates.find((k) => input.declKeys.has(k));
    if (!declKey) continue;
    const removed = input.overloads?.get(declKey.replace(/^kotlin:/, ""));
    if (removed && desc) {
      const params = descriptorParams(desc).map(simple);
      if (!removed.some((p) => p.length === params.length && p.every((t, i) => simple(t) === params[i])))
        continue;
    }
    const file = src ? resolve(cls, src) : null;
    if (!file) {
      unresolved++;
      continue;
    }
    let line = Number(lineText0) || 0;
    if (line === 0) {
      // A supertype: the class declaration line.
      const name =
        cls
          .slice(cls.lastIndexOf("/") + 1)
          .split("$")
          .pop() ?? "";
      const at = (input.tree.read(file) ?? "")
        .split("\n")
        .findIndex((l) => new RegExp(`\\b(?:class|interface|object)\\s+${name}\\b`).test(l));
      line = at >= 0 ? at + 1 : 1;
    }
    if (hits.some((h) => h.file === file && h.line === line && h.declKey === declKey)) continue;
    hits.push({
      file,
      line,
      column: 1,
      kind: kind === "new" ? "new" : kind === "field" ? "property" : kind === "call" ? "call" : "type-ref",
      snippet: lineText(file, line).trim().slice(0, 200),
      resolution: "type",
      declKey,
    });
  }
  // Sources that use the library but compiled to no class: their uses weren't read.
  const prefix = !input.projectRoot || input.projectRoot === "." ? "" : `${input.projectRoot}/`;
  const uses = (text: string) =>
    (input.packages ?? []).some((p) => new RegExp(`\\b${p.replace(/\./g, "\\.")}\\.`).test(text));
  const uncompiled = classRows
    ? files.filter(
        (f) =>
          f.startsWith(prefix) &&
          /\.(?:java|kt)$/.test(f) &&
          !/(?:^|\/)(?:build|target)\//.test(f) &&
          !compiled.has(f) &&
          uses(input.tree.read(f) ?? ""),
      )
    : [];
  return {
    hits,
    imports: [],
    ms: Date.now() - started,
    coverage: {
      // Every source file that compiled (older images printed no class rows: the files with hits).
      filesScanned: classRows ? compiled.size : new Set(hits.map((h) => h.file)).size,
      filesSkipped: [
        ...(unresolved
          ? [{ reason: "class files whose source was not found in the repo", count: unresolved }]
          : []),
        ...(uncompiled.length
          ? [
              {
                reason: "sources that use the library but did not compile to a class",
                count: uncompiled.length,
              },
            ]
          : []),
        ...(sourceless
          ? [{ reason: "classes compiled without source file names (-g:none)", count: sourceless }]
          : []),
      ],
      languages: ["java", "kotlin"],
      resolutionLevel: "type",
      unresolvedSites: unresolved + uncompiled.length + sourceless,
      transitiveAnalysed: false,
    },
  };
}
