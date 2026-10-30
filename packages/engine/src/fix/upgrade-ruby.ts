import { dirname, join } from "node:path";
import { type CallNode, loadPrism, type Node, Visitor } from "@ruby/prism";
import type { DependencyInstance } from "../contract";
import type { RubyProject } from "../inventory/ruby";
import type { RepoTree } from "../inventory/tree";
import { rubygemsScheme } from "../registry/versions";
import type { Transaction } from "./transaction";
import type { ManifestEdit } from "./upgrade-js";

/**
 * The Bundler upgrade transaction (plan S07, research ruby.md Job 7). The Gemfile (or gemspec) is
 * Ruby code, so the worker never evaluates it: Prism finds the `gem "faraday", "~> 1.10"` call and
 * only the requirement's bytes are replaced, keeping quotes, comments and layout. The requirement is
 * edited only when it excludes the target. Then, in the sandbox, `bundle lock --update faraday
 * --conservative --cooldown N` re-resolves that gem alone (shared dependencies stay put; versions
 * younger than the cooldown are skipped, so Bundler lands on the version Teire analysed), and
 * platforms the sandbox added to the lockfile are removed again.
 */
type Parse = Awaited<ReturnType<typeof loadPrism>>;
let parser: Promise<Parse> | null = null;

const DECLARERS = new Set(["gem", "add_dependency", "add_runtime_dependency", "add_development_dependency"]);

function bump(requirement: string, target: string): string {
  const m = /^\s*(~>|>=|<=|!=|=|>|<)?\s*(\S+)\s*$/.exec(requirement);
  if (!m?.[2]) return requirement;
  const op = m[1] ?? "";
  const segments = m[2].split(".").length;
  const t = target.split(".");
  switch (op) {
    case "~>":
      return `~> ${t.slice(0, Math.max(segments, 2)).join(".")}`;
    case "<":
      return `< ${Number(t[0]) + 1}`;
    case "<=":
      return `<= ${target}`;
    case "=":
      return `= ${target}`;
    case "":
      return target;
    default:
      return requirement;
  }
}

/** The requirement strings that admit `target`, or null when the declared ones already do. */
export function gemRequirementFor(requirements: string[], target: string): string[] | null {
  const ok = (r: string) => {
    try {
      return rubygemsScheme.satisfies(target, r);
    } catch {
      return false;
    }
  };
  if (requirements.every(ok)) return null;
  const next = requirements
    .filter((r) => !/^\s*!=/.test(r) || ok(r))
    .map((r) => (ok(r) ? r : bump(r, target)));
  return next.every(ok) ? next : [`~> ${target.split(".").slice(0, 2).join(".")}`];
}

interface Located {
  start: number;
  end: number;
  requirements: string[];
  quote: string;
}

/** Byte range of the requirement arguments of `gem "<name>", …` (or a gemspec's add_dependency). */
async function findDeclaration(text: string, name: string): Promise<Located | null> {
  parser ??= loadPrism();
  const parse = await parser;
  const result = parse(text);
  let found: Located | null = null;
  class Finder extends Visitor {
    override visitCallNode(node: CallNode) {
      if (!found && DECLARERS.has(node.name)) {
        const args = ((node.arguments_ as unknown as { arguments_?: Node[] } | null)?.arguments_ ??
          []) as unknown as {
          constructor: { name: string };
          unescaped?: { value?: string } | string;
          location: { startOffset: number; length: number };
        }[];
        const str = (a: (typeof args)[number] | undefined) =>
          a?.constructor.name === "StringNode"
            ? typeof a.unescaped === "string"
              ? a.unescaped
              : (a.unescaped?.value ?? null)
            : null;
        if (str(args[0]) === name) {
          const reqs = args.slice(1).filter((a) => a.constructor.name === "StringNode");
          const first = reqs[0];
          const last = reqs[reqs.length - 1];
          const head = args[0] as (typeof args)[number];
          const quote = Buffer.from(text)
            .subarray(head.location.startOffset, head.location.startOffset + 1)
            .toString();
          found =
            first && last
              ? {
                  start: first.location.startOffset,
                  end: last.location.startOffset + last.location.length,
                  requirements: reqs.map((r) => str(r) ?? ""),
                  quote: quote === "'" ? "'" : '"',
                }
              : {
                  // No requirement: insert one after the name.
                  start: head.location.startOffset + head.location.length,
                  end: head.location.startOffset + head.location.length,
                  requirements: [],
                  quote: quote === "'" ? "'" : '"',
                };
        }
      }
      super.visitCallNode(node);
    }
  }
  result.value.accept(new Finder());
  return found;
}

/** The manifest text with the gem's requirement admitting `target`; null when no edit is needed. */
export async function editGemRequirement(text: string, name: string, target: string) {
  const at = await findDeclaration(text, name);
  if (!at || at.requirements.length === 0) return null;
  const next = gemRequirementFor(at.requirements, target);
  if (!next) return null;
  const bytes = Buffer.from(text);
  const rendered = next.map((r) => `${at.quote}${r}${at.quote}`).join(", ");
  return {
    text: Buffer.concat([
      bytes.subarray(0, at.start),
      Buffer.from(rendered),
      bytes.subarray(at.end),
    ]).toString(),
    from: at.requirements.join(", "),
    to: next.join(", "),
  };
}

const lockedAt = (lock: string, name: string, version: string) =>
  new RegExp(
    `^ {4}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(${version.replace(/\./g, "\\.")}(?:-[^)]+)?\\)$`,
    "m",
  ).test(lock);

export async function rubyTransaction(
  tree: RepoTree,
  project: RubyProject,
  instance: DependencyInstance,
  target: string,
  cooldownDays: number,
): Promise<Transaction> {
  const edits: ManifestEdit[] = [];
  const root = project.root;
  // The Gemfile first; a gem declared by the project's own gemspec (`gemspec` in the Gemfile) there.
  // The file that declares it first (an `eval_gemfile`d one, S18.4).
  const candidates = [
    ...new Set([
      instance.manifestPath,
      project.manifest,
      ...tree.files().filter((f) => dirname(f) === root && f.endsWith(".gemspec")),
    ]),
  ];
  for (const path of candidates) {
    const before = tree.read(path);
    if (before === null) continue;
    const edit = await editGemRequirement(before, instance.name, target);
    if (!edit) {
      if (await findDeclaration(before, instance.name)) break;
      continue;
    }
    edits.push({ path, before, after: edit.text, from: edit.from, to: edit.to });
    break;
  }
  const lock = project.lockfile ?? (root === "." ? "Gemfile.lock" : join(root, "Gemfile.lock"));
  const readBack = [...new Set([...edits.map((e) => e.path), lock])];
  const check = (files: Record<string, string>) =>
    lockedAt(files[lock] ?? "", instance.name, target)
      ? null
      : `${lock} does not lock ${instance.name} ${target}`;
  const edited = edits[0] ? `${edits[0].path}: ${instance.name} "${edits[0].from}" → "${edits[0].to}"; ` : "";
  return {
    describe: `${edited}bundle lock --update ${instance.name} --conservative --cooldown ${cooldownDays}`,
    manifest: edits,
    commands: [["teire-ruby", "lock", instance.name, String(cooldownDays)]],
    readBack,
    lockfilePath: lock,
    check,
    // A lockfile's older Bundler may not know --cooldown: the same update without it.
    fallback: {
      describe: `${edited}bundle lock --update ${instance.name} --conservative`,
      manifest: edits,
      commands: [["teire-ruby", "lock", instance.name]],
      readBack,
      lockfilePath: lock,
      check,
    },
  };
}
