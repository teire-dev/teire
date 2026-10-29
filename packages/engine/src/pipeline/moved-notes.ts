import type { Ecosystem } from "../contract";
import type { MigrationNote } from "../fix/codemods";
import type { ModelPrice, TokenFactory } from "../llm";
import { documentsForReading, extractNotes, migrationNotes } from "../notes/extract";
import {
  gatherCargoNotes,
  gatherGoNotes,
  gatherJvmNotes,
  gatherNpmNotes,
  gatherPypiNotes,
  gatherRubyNotes,
  type NotesOptions,
} from "../notes/sources";

const GATHER: Record<Ecosystem, typeof gatherNpmNotes> = {
  npm: gatherNpmNotes,
  pypi: gatherPypiNotes,
  go: gatherGoNotes,
  cargo: gatherCargoNotes,
  rubygems: gatherRubyNotes,
  maven: gatherJvmNotes,
};

/**
 * A moved package's own release notes (D-10), read like the lead's: its slice from the version it
 * had to the one the updater moved it to, by Nemotron 3 Ultra behind the quote gate. Each note
 * names its package, so the agent doesn't take a note about `http` for one about `reqwest`.
 */
export async function movedPackageNotes(input: {
  tf: TokenFactory;
  prices?: Map<string, ModelPrice>;
  ecosystem: Ecosystem;
  name: string;
  from: string;
  to: string;
  /** The located sites' snippets, so the reader looks for what this code uses. */
  removedApis: string[];
  options: NotesOptions;
}): Promise<MigrationNote[]> {
  const { sources } = await GATHER[input.ecosystem](input.name, input.from, input.to, input.options);
  const docs = documentsForReading(sources);
  if (!docs.length) return [];
  const extraction = await extractNotes(
    input.tf,
    docs,
    { name: input.name, from: input.from, to: input.to, removedApis: input.removedApis },
    input.prices,
  );
  return migrationNotes(extraction).map((n) => ({
    ...n,
    summary: `${input.name} ${input.from} → ${input.to}: ${n.summary}`,
  }));
}
