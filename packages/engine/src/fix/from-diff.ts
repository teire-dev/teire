import { applyPatch, parsePatch } from "diff";

/**
 * A run's files rebuilt from its stored diff (one `createTwoFilesPatch` per file) over the commit it
 * started from, so "Open draft anyway" (U2) publishes exactly what the run ended with. A binary file,
 * a path outside the repository or a patch that no longer applies is an error naming the file,
 * never a guess.
 */
export function filesFromDiff(
  diff: string,
  read: (path: string) => string | null,
): { files: { path: string; content: string | null }[] } | { error: string } {
  // A binary file's bytes aren't in the diff; its deletion needs none (U2 review).
  const binary = /^Binary files a\/(\S+) and (?!\/dev\/null)/m.exec(diff);
  if (binary) return { error: `the run changed a binary file (\`${binary[1]}\`) that its diff can't carry` };
  const files: { path: string; content: string | null }[] = [];
  for (const m of diff.matchAll(/^Binary files a\/(\S+) and \/dev\/null differ$/gm)) {
    const path = m[1] ?? "";
    if (!path || path.split("/").includes(".."))
      return { error: `the run's diff names a path outside the repository (\`${path}\`)` };
    files.push({ path, content: null });
  }
  for (const patch of parsePatch(diff)) {
    if (!patch.hunks.length) continue;
    const deleted = patch.newFileName === "/dev/null";
    const path = ((deleted ? patch.oldFileName : patch.newFileName) ?? "").replace(/^[ab]\//, "");
    if (!path || path.startsWith("/") || path.split("/").includes(".."))
      return { error: `the run's diff names a path outside the repository (\`${path}\`)` };
    const after = applyPatch(read(path) ?? "", patch);
    if (after === false) return { error: `the run's diff no longer applies to \`${path}\`` };
    files.push({ path, content: deleted ? null : after });
  }
  return files.length ? { files } : { error: "the run's diff changes no files" };
}
