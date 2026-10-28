import { VERIFY } from "../constants";
import type { Transaction } from "../fix/transaction";
import type { ResolverResult } from "./events";

/**
 * The resolver's change as the fix loop's transaction (plan S15.1): the dependency files exactly as
 * dependabot-core's updater wrote them, with no regeneration in the sandbox (the updater already
 * resolved them). Text files are manifest edits; binary files and deletions are byte writes;
 * symlinks are linked. The after side then installs and runs the checks as for any transaction.
 */
const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|pylock\.toml|Pipfile\.lock|requirements[^/]*\.txt|go\.sum|Cargo\.lock|Gemfile\.lock|gems\.locked|gradle\.lockfile|[^/]+\.lockfile)$/;

export function resolverTransaction(
  change: Extract<ResolverResult, { kind: "change" }>,
  read: (path: string) => string | null,
  lead: { name: string; from: string | null },
): Transaction {
  const text = change.files.filter((f) => f.content !== null && !f.encoding && f.mode !== "120000");
  const links = change.files.filter((f) => f.mode === "120000" && f.content !== null);
  const lockfilePath = change.files.find((f) => f.content !== null && LOCKFILE.test(f.path))?.path;
  return {
    describe: `dependabot-core's updater: ${
      change.moved
        .map((m) => `${m.name} ${m.from ?? "?"} → ${m.removed ? "removed" : (m.to ?? "?")}`)
        .join(", ") || lead.name
    } (${change.files.map((f) => f.path).join(", ")})`,
    manifest: text.map((f) => ({
      path: f.path,
      before: read(f.path) ?? "",
      after: f.content as string,
      from: lead.from ?? "",
      to: change.leadVersion ?? "",
    })),
    writes: change.files
      .filter((f) => f.content === null || f.encoding === "base64")
      .map((f) => ({ path: f.path, bytes: f.content === null ? null : Buffer.from(f.content, "base64") })),
    commands: links.map((f) => ["ln", "-sfn", f.content as string, `${VERIFY.workDir}/${f.path}`]),
    readBack: change.files.filter((f) => f.content !== null && f.mode !== "120000").map((f) => f.path),
    moved: change.moved,
    ...(lockfilePath ? { lockfilePath } : {}),
  };
}
