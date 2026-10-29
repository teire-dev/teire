import type { DependencyInstance } from "../contract";
import type { Transaction } from "./transaction";

const bare = (v: string | null | undefined) => v?.replace(/^v(?=\d)/, "") ?? null;

/**
 * The chosen-version readback (S15.1, R21.12): the files a PR commits, read back with Teire's own
 * lockfile readers, must lock the lead at the version the run names and every package the updater
 * moved at its new version. Null when they do, or when a package isn't in what the readers see (a
 * lockfile they can't read is never taken as a mismatch); otherwise what disagrees, for a named stop.
 */
export function readbackMismatch(
  after: readonly Pick<DependencyInstance, "ecosystem" | "name" | "version">[],
  ecosystem: string,
  lead: string,
  target: string,
  moved: NonNullable<Transaction["moved"]>,
): string | null {
  const versions = (name: string) =>
    after
      .filter((i) => i.ecosystem === ecosystem && i.name === name && i.version)
      .map((i) => bare(i.version));
  const leadAt = versions(lead);
  if (leadAt.length && !leadAt.includes(bare(target)))
    return `the files this PR commits lock ${lead} at ${[...new Set(leadAt)].join(", ")}, not ${target}`;
  for (const m of moved) {
    if (m.removed || !m.to || m.name === lead) continue;
    const at = versions(m.name);
    if (at.length && !at.includes(bare(m.to)))
      return `the updater says it moved ${m.name} to ${m.to}, but the files lock it at ${[...new Set(at)].join(", ")}`;
  }
  return null;
}
