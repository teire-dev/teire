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
 * contents are blanked first. A site written through the crate's path, or a name the file `use`s
 * from it, is resolved by that import; a trait method's call on an unknown receiver is by name only.
 * After the bump `cargo check` is the authority.
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
    const blanked = blank(raw);
    const lines = blanked.split("\n");
    const rawLines = raw.split("\n");
    // Whole `use` statements, multi-line groups included, and the lines each one spans.
    const uses = [...blanked.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s[^;]*;/gm)].map((m) => {
      const first = blanked.slice(0, m.index ?? 0).split("\n").length - 1;
      return { text: m[0], first, last: first + m[0].split("\n").length - 1 };
    });
    const imports = uses.map((u) => u.text).join("\n");
    const statementAt = (i: number) => uses.find((u) => i >= u.first && i <= u.last);
    const glob = new RegExp(`\\buse\\s+${esc(ident)}::(?:prelude|\\w+)::\\*`).test(imports);
    lines.forEach((line, i) => {
      for (const key of keys) {
        if (key.startsWith("feature:")) continue;
        const site = (kind: Hit["kind"], column: number, resolution: Hit["resolution"] = "import") =>
          add({
            file,
            line: i + 1,
            column: column + 1,
            kind,
            snippet: (rawLines[i] ?? "").trim().slice(0, 200),
            resolution,
            declKey: key,
          });
        if (crateKey(key)) {
          const full = asWritten(key);
          const use = statementAt(i);
          const at = line.search(new RegExp(`\\b${esc(full)}\\b(?!::\\w)|\\b${esc(full)}::`));
          if (at >= 0) {
            site(use ? "import" : "type-ref", at);
            continue;
          }
          // `use rand::distributions::{Uniform, Distribution}`, on one line or several: the name in
          // the group of its parent path.
          const parent = full.slice(0, full.lastIndexOf("::"));
          const last = full.slice(full.lastIndexOf("::") + 2);
          const name = new RegExp(`(?<![\\w:.])${esc(last)}\\b`);
          if (use) {
            if (new RegExp(`\\b${esc(parent)}::\\{[^}]*\\b${esc(last)}\\b`).test(use.text)) {
              const g = line.search(name);
              if (g >= 0) site("import", g);
            }
            continue;
          }
          // Used bare after its own `use` (`use rand::thread_rng;` … `thread_rng()`): resolved by
          // that import. A prelude item under `use crate::prelude::*` is too, unless the file
          // declares its own of that name.
          const named = new RegExp(
            `\\b${esc(parent)}::(?:${esc(last)}\\s*;|\\{[^}]*\\b${esc(last)}\\b[^}]*\\})`,
          ).test(imports);
          const viaGlob = glob && /::prelude::/.test(full);
          if (named || viaGlob) {
            const bare = line.search(named ? name : new RegExp(`(?<![\\w:.])${esc(last)}\\s*[(<]`));
            if (bare >= 0)
              site(
                /^\s*\(/.test(line.slice(bare + last.length)) ? "call" : "type-ref",
                bare,
                named || !new RegExp(`\\bfn\\s+${esc(last)}\\b`).test(blanked) ? "import" : "name-only",
              );
          }
        } else if (key.includes("::")) {
          // `Trait::method`: a method call in a file that imports the trait or a glob.
          const [trait, method] = [key.slice(0, key.lastIndexOf("::")), key.slice(key.lastIndexOf("::") + 2)];
          const traitName = trait.split("::").at(-1) ?? trait;
          if (!glob && !new RegExp(`\\b${esc(traitName)}\\b`).test(imports)) continue;
          const call = line.search(new RegExp(`\\.${esc(method)}\\s*(?:::<[^>]*>)?\\s*\\(`));
          // Any receiver whose type has a method of that name matches: by name only.
          if (call >= 0) site("call", call + 1, "name-only");
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
