import { FIX } from "../constants";
import { lookupDocs } from "../fix/context7";
import { runPythonHelper } from "../python/helper";

interface PyDocs {
  objects: { path: string; kind: string; signature: string | null; docstring: string | null }[];
  readme: string[];
  unread: string[];
}

/**
 * The agent's `lookup_docs` for a PyPI package (R21.5): Context7 first, pinned to the target when it
 * indexes that version, then the target version's own source, which is always the right version:
 * griffe reads the unpacked wheel statically for the objects the question names (signature and
 * docstring) and the README sections that mention them. Each answer says which source it is.
 */
export function pythonDocsLookup(input: {
  name: string;
  target: string;
  /** The unpacked target wheel (the surface diff already fetched it). */
  targetDir: string;
  /** `owner/repo` from the package's project URLs, so Context7 prefers the repo-owned library. */
  sourceRepo?: string;
  context7Key?: string;
}) {
  return async (query: string) => {
    const [c7, own] = await Promise.all([
      lookupDocs({
        packageName: input.name,
        ...(input.sourceRepo ? { sourceRepo: input.sourceRepo } : {}),
        target: input.target,
        query,
        exactOnly: true,
        ...(input.context7Key ? { apiKey: input.context7Key } : {}),
      }).catch((error: unknown) => ({
        note: `Context7 is unreachable (${String(error).slice(0, 120)})`,
        text: "",
      })),
      runPythonHelper<PyDocs>("docs", [input.targetDir, query]).catch(() => null),
    ]);
    const parts = [c7.text ? `Context7 (${c7.note}):\n${c7.text}` : `Context7: ${c7.note}.`];
    if (own?.objects.length || own?.readme.length) {
      parts.push(
        [
          `${input.name} ${input.target}'s own source:`,
          ...(own.objects ?? []).map(
            (o) =>
              `- ${o.path} (${o.kind})${o.signature ? `\n    ${o.signature}` : ""}${o.docstring ? `\n    ${o.docstring.replace(/\n/g, "\n    ")}` : ""}`,
          ),
          ...(own.readme ?? []).map((r) => `README:\n${r}`),
        ].join("\n"),
      );
    } else
      parts.push(
        own
          ? `${input.name} ${input.target}'s own source names nothing from this question${own.unread.length ? ` (unread: ${own.unread.join(", ")})` : ""}.`
          : `${input.name} ${input.target}'s own source couldn't be read.`,
      );
    return parts.join("\n\n").slice(0, FIX.maxDocsChars);
  };
}
