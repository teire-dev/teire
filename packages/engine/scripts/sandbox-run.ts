/**
 * Runs commands in a fresh verification sandbox on a repo's tarball and prints their full output,
 * for diagnosing a baseline (scripts/baseline.ts shows only output tails). No GitHub writes.
 * Run: pnpm --filter @teire/engine exec tsx --env-file=../../.env.local scripts/sandbox-run.ts owner/repo image "cmd 1" "cmd 2" …
 * The first command runs with the network on (install phase), the rest with it off.
 */
import { randomBytes } from "node:crypto";
import { selectBackend } from "../src/verify";

const [slug, image, ...commands] = process.argv.slice(2);
if (!slug?.includes("/") || !image || !commands.length)
  throw new Error('usage: sandbox-run.ts owner/repo image "install cmd" ["check cmd" …]');
const token = process.env.GITHUB_TOKEN;
const { backend } = await selectBackend();
const session = await backend.open(`diag-${randomBytes(3).toString("hex")}`, {
  tarball: { url: `https://api.github.com/repos/${slug}/tarball/HEAD`, ...(token ? { token } : {}) },
  image,
  instance: "standard-3",
});
try {
  for (const [i, command] of commands.entries()) {
    if (i === 1) await session.setPhase("check");
    const run = await session.run(`diag-${i}`, ["sh", "-c", command], { cwd: "/work", timeoutSec: 900 });
    console.log(`$ ${command}\n(exit ${run.exitCode} in ${run.ms} ms)\n${run.stdout}${run.stderr}`);
  }
} finally {
  await session.close();
}
