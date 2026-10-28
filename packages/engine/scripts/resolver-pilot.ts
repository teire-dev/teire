/**
 * The resolver pilot (plan S14.4): real jobs through the resolver service, as the worker sends
 * them, one case per package manager plus the negative cases, each with what it should return.
 * Run with the service reachable (an SSH tunnel to its gateway address) and its secret:
 *   TEIRE_RESOLVER_URL=http://127.0.0.1:8788 TEIRE_RESOLVER_SECRET=… \
 *   pnpm --filter @teire/engine exec tsx scripts/resolver-pilot.ts cases.json [case-name…]
 * cases.json: [{ name, repo, manager, ecosystem, roots, shape, expect: { kind, lead?, type? } }]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Ecosystem } from "../src/contract";
import { type JobShape, resolve, resolverConfigFromEnv, type TeireManager } from "../src/resolver";

interface Case {
  name: string;
  repo: string;
  manager: TeireManager;
  ecosystem: Ecosystem;
  roots: string[];
  shape: JobShape;
  expect: { kind: string; lead?: string; type?: string };
}

const [file, ...only] = process.argv.slice(2);
if (!file) throw new Error("usage: resolver-pilot.ts cases.json [name…]");
const config = resolverConfigFromEnv();
if (!config) throw new Error("TEIRE_RESOLVER_URL and TEIRE_RESOLVER_SECRET are required");
const cases = (JSON.parse(readFileSync(file, "utf8")) as Case[]).filter(
  (c) => !only.length || only.includes(c.name),
);
const head = (repo: string) =>
  execFileSync("gh", ["api", `repos/${repo}/commits/HEAD`, "--jq", ".sha"], { encoding: "utf8" }).trim();

for (const c of cases) {
  const commit = head(c.repo);
  const lead = "dependency" in c.shape ? c.shape.dependency : c.name;
  const started = Date.now();
  try {
    const run = await resolve(config, { ...c, repo: c.repo, commit }, { ecosystem: c.ecosystem, name: lead });
    const r = run.result;
    const got =
      r.kind === "change"
        ? {
            kind: r.kind,
            lead: r.leadVersion,
            files: r.files.map((f) => f.path),
            moved: r.moved.map((m) => `${m.name} ${m.from} → ${m.to}`),
          }
        : r.kind === "stop"
          ? { kind: r.kind, type: r.type, message: r.message }
          : r;
    const pass =
      got.kind === c.expect.kind &&
      (!c.expect.lead || ("lead" in got && got.lead === c.expect.lead)) &&
      (!c.expect.type || ("type" in got && got.type === c.expect.type));
    console.log(
      JSON.stringify({ case: c.name, pass, ms: run.ms, state: run.state, commit: commit.slice(0, 7), got }),
    );
    // Why it differs, from the updater's own log: errors, and what it said about the lead dependency.
    if (!pass && run.stderrTail)
      console.log(
        run.stderrTail
          .split("\n")
          .filter(
            (l) => /error|Error|ERROR|ignor|requires|latest|resolvable|filter/.test(l) || l.includes(lead),
          )
          .filter((l) => !/proxy \|.*(GET|POST) /.test(l))
          .slice(-15)
          .join("\n"),
      );
  } catch (error) {
    console.log(
      JSON.stringify({
        case: c.name,
        pass: false,
        ms: Date.now() - started,
        error: (error as Error).message,
      }),
    );
  }
}
