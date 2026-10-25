import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoTree } from "../inventory/tree";
import type { Hit, LocateResult } from "./ts";

/**
 * Rust uses of a crate's changed items (plan S06, research rust.md Job 5), syntactic, in the
 * worker: type-resolved Rust needs rust-analyzer with the dependencies built (sandbox), and after
 * the bump `cargo check` names every broken line anyway. Here: full and module paths
 * (`rand::distributions::Uniform`), `use` groups, prelude globs with bare calls, trait methods called
 * in files that import the trait, and removed features named in Cargo.toml. Comments and string
 * contents are blanked first. Every site is "name-only"; the compiler is the authority.
 */
function blank(text: string) {
  // Line structure kept: comments and string contents become spaces.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => `"${" ".repeat(m.length - 2)}"`);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function locateRust(input: {
  repoDir: string;
  tree: RepoTree;
  projectRoot: string;
  /** Registry name (`rand`) and the name the code uses when renamed (`package = …`). */
  crate: string;
  alias?: string;
  declKeys: ReadonlySet<string>;
  manifests: string[];
}): LocateResult {
  const started = Date.now();
  const ident = (input.alias ?? input.crate).replace(/-/g, "_");
  const prefix = input.projectRoot === "." ? "" : `${input.projectRoot}/`;
  const files = input.tree
    .files()
    .filter((f) => f.endsWith(".rs") && f.startsWith(prefix) && !/(?:^|\/)target\//.test(f));
  const hits: Hit[] = [];
  const add = (hit: Hit) => {
    if (!hits.some((h) => h.file === hit.file && h.line === hit.line && h.declKey === hit.declKey))
      hits.push(hit);
  };
  const keys = [...input.declKeys];
  const crateKey = (k: string) =>
    k.startsWith(`${input.crate.replace(/-/g, "_")}::`) || k.startsWith(`${input.crate}::`);
  // A path the code writes with its own crate name (renames included).
  const asWritten = (k: string) => k.replace(/^[\w-]+::/, `${ident}::`);

  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(join(input.repoDir, file), "utf8");
    } catch {
      continue;
    }
    if (!raw.includes(ident)) continue;
    const lines = blank(raw).split("\n");
    const rawLines = raw.split("\n");
    const imports = lines.filter((l) => /^\s*(?:pub\s+)?use\s/.test(l)).join("\n");
    const glob = new RegExp(`\\buse\\s+${esc(ident)}::(?:prelude|\\w+)::\\*`).test(imports);
    lines.forEach((line, i) => {
      for (const key of keys) {
        if (key.startsWith("feature:")) continue;
        const site = (kind: Hit["kind"], column: number) =>
          add({
            file,
            line: i + 1,
            column: column + 1,
            kind,
            snippet: (rawLines[i] ?? "").trim().slice(0, 200),
            resolution: "name-only",
            declKey: key,
          });
        if (crateKey(key)) {
          const full = asWritten(key);
          const at = line.search(new RegExp(`\\b${esc(full)}\\b(?!::\\w)|\\b${esc(full)}::`));
          if (at >= 0) {
            site(/^\s*(?:pub\s+)?use\s/.test(line) ? "import" : "type-ref", at);
            continue;
          }
          // `use rand::distributions::{Uniform, Distribution}`: the parent path, then the name in the group.
          const parent = full.slice(0, full.lastIndexOf("::"));
          const last = full.slice(full.lastIndexOf("::") + 2);
          const group = new RegExp(`\\b${esc(parent)}::\\{[^}]*\\b${esc(last)}\\b`);
          const g = line.search(group);
          if (g >= 0) site("import", g);
          // A prelude item called bare under `use crate::prelude::*` (`thread_rng()`).
          else if (glob && /::prelude::/.test(full)) {
            const bare = line.search(new RegExp(`(?<![\\w:.])${esc(last)}\\s*[(<]`));
            if (bare >= 0) site("call", bare);
          }
        } else if (key.includes("::")) {
          // `Trait::method`: a method call in a file that imports the trait or a glob.
          const [trait, method] = [key.slice(0, key.lastIndexOf("::")), key.slice(key.lastIndexOf("::") + 2)];
          const traitName = trait.split("::").at(-1) ?? trait;
          if (!glob && !new RegExp(`\\b${esc(traitName)}\\b`).test(imports)) continue;
          const call = line.search(new RegExp(`\\.${esc(method)}\\s*(?:::<[^>]*>)?\\s*\\(`));
          if (call >= 0) site("call", call + 1);
        }
      }
    });
  }

  // Removed features the repo turns on in its dependency entry.
  const features = keys.filter((k) => k.startsWith("feature:")).map((k) => k.slice(8));
  if (features.length)
    for (const manifest of input.manifests) {
      const text = input.tree.read(manifest) ?? "";
      text.split("\n").forEach((line, i) => {
        if (
          !new RegExp(`^\\s*(?:${esc(input.alias ?? input.crate)}|"${esc(input.crate)}")\\s*=`).test(line) &&
          !line.includes(`package = "${input.crate}"`)
        )
          return;
        for (const f of features)
          if (new RegExp(`["']${esc(f)}["']`).test(line))
            add({
              file: manifest,
              line: i + 1,
              column: line.indexOf(f) + 1,
              kind: "config",
              snippet: line.trim().slice(0, 200),
              resolution: "name-only",
              declKey: `feature:${f}`,
            });
      });
    }

  return {
    hits,
    imports: [],
    ms: Date.now() - started,
    coverage: {
      filesScanned: files.length,
      filesSkipped: [],
      languages: ["rust"],
      resolutionLevel: "syntax",
      unresolvedSites: 0,
      transitiveAnalysed: false,
    },
  };
}
