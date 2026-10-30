import type { DependencyInstance } from "../contract";
import type { Transaction } from "./transaction";

const bare = (v: string | null | undefined) => v?.replace(/^v(?=\d)/, "") ?? null;

/** One lockfile root as Teire's readers see it, before or after the change. */
export interface ReadbackRoot {
  root: string;
  instances: readonly Pick<DependencyInstance, "name" | "version" | "direct" | "environment">[];
}

/**
 * A Go major moves to a new module path, and the run names it `path version`
 * (`github.com/x/y/v2 v2.0.0`): the readback reads that path at that version. The old path can stay
 * as another module's indirect requirement and is not the lead any more.
 */
export function leadAfter(lead: string, target: string): { name: string; version: string } {
  const [path, version] = target.split(" ");
  return path && version ? { name: path, version } : { name: lead, version: target };
}

/**
 * The chosen-version readback (S15.1, R21.12): the files a PR commits, read back with Teire's own
 * lockfile readers in the roots the run changed, must lock the lead at the version the run names and
 * every package the updater moved at its new version. Each root is compared with itself before the
 * change, so a package the readers never saw there is unknown, not a mismatch; one they saw and no
 * longer see, or can't read any more, is. Every direct copy of the lead must be at the target, except
 * where the lockfile keeps one per environment (uv's marker forks), where the target must be among
 * them. Null when the files agree; otherwise what disagrees, for a named stop.
 */
export function readbackMismatch(input: {
  before: readonly ReadbackRoot[];
  after: readonly ReadbackRoot[];
  /** The package the run upgraded, under its name before and after (a Go major's new path). */
  lead: { before: string; after: string };
  target: string;
  moved: NonNullable<Transaction["moved"]>;
}): string | null {
  const { lead, target } = input;
  const where = (root: string) => (root === "." ? "the repository root" : root);
  const shown = (versions: (string | null)[]) =>
    [...new Set(versions.map((v) => v ?? "a version they can't read"))].join(", ");
  for (const before of input.before) {
    const had = before.instances.filter((i) => i.name === lead.before && i.version);
    if (!had.length) continue;
    const after = input.after.find((r) => r.root === before.root);
    if (!after)
      return `Teire's lockfile readers read ${where(before.root)} before the change and can't after it`;
    const direct = had.some((i) => i.direct);
    const now = after.instances.filter((i) => i.name === lead.after && (!direct || i.direct));
    if (!now.length)
      return `the files this PR commits don't lock ${lead.after} in ${where(before.root)} any more`;
    const versions = now.map((i) => bare(i.version));
    const forked = now.some((i) => i.environment?.markers);
    const agrees =
      direct && !forked ? versions.every((v) => v === bare(target)) : versions.includes(bare(target));
    if (!agrees)
      return `the files this PR commits lock ${lead.after} at ${shown(versions)} in ${where(before.root)}, not ${target}`;
  }
  const all = (roots: readonly ReadbackRoot[], name: string) =>
    roots.flatMap((r) => r.instances.filter((i) => i.name === name && i.version).map((i) => bare(i.version)));
  for (const m of input.moved) {
    if (m.removed || !m.to || m.name === lead.before || m.name === lead.after) continue;
    const at = all(input.after, m.name);
    if (!at.length && all(input.before, m.name).length)
      return `the updater says it moved ${m.name} to ${m.to}, but the files don't lock it any more`;
    if (at.length && !at.includes(bare(m.to)))
      return `the updater says it moved ${m.name} to ${m.to}, but the files lock it at ${shown(at)}`;
  }
  return null;
}
