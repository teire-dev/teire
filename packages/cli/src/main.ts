import "./env";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { catalogUrl, getChange, listChanges } from "./catalog";
import { serveMcp } from "./mcp";
import { groupFindings, renderChange, renderScan, scanJson } from "./render";
import { scanPath } from "./scan";

declare const TEIRE_VERSION: string;

const HELP = `teire — every dependency and API change that affects your code, from the terminal

Usage
  teire scan [path] [--json] [--all]       Scan a checkout (default: the current directory)
  teire check [path] [--fail-on affected|deadline|any] [--within 90]
                                           Exit 1 when the gate fails (for CI)
  teire explain <change-id> [--json]       One change record: summary, migration, quoted sources
  teire changes [--provider p] [--ecosystem e] [--kind k] [--subject s] [--json]
                                           The public catalog Teire has read
  teire mcp                                 Serve the same tools to coding agents over MCP (stdio)

Environment
  GITHUB_TOKEN           Higher GitHub rate limits (release notes, advisories, spec history)
  TOKENFACTORY_API_KEY   Trace wrapped model IDs with Nemotron, as the service does
  TEIRE_URL              Another Teire deployment (default https://teire.vercel.app)
`;

function fail(message: string): never {
  process.stderr.write(`teire: ${message}\n`);
  process.exit(2);
}

async function main(argv: string[]) {
  const [command = "help", ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      "fail-on": { type: "string", default: "affected" },
      within: { type: "string", default: "90" },
      provider: { type: "string" },
      ecosystem: { type: "string" },
      kind: { type: "string" },
      subject: { type: "string" },
    },
  });
  const base = catalogUrl();
  const scanOptions = {
    catalogUrl: base,
    ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}),
  };
  switch (command) {
    case "scan": {
      const scan = await scanPath(resolve(positionals[0] ?? "."), scanOptions);
      process.stdout.write(
        values.json
          ? `${JSON.stringify(scanJson(scan), null, 2)}\n`
          : `${renderScan(scan, { all: values.all })}\n`,
      );
      return;
    }
    case "check": {
      const gate = values["fail-on"];
      if (!["affected", "deadline", "any"].includes(gate))
        fail(`--fail-on must be affected, deadline or any (got ${gate})`);
      const within = Number.parseInt(values.within.replace(/d$/, ""), 10);
      if (!Number.isFinite(within) || within < 0)
        fail(`--within takes a number of days (got ${values.within})`);
      const scan = await scanPath(resolve(positionals[0] ?? "."), scanOptions);
      const groups = groupFindings(scan);
      const horizon = Date.now() + within * 86_400_000;
      const failing = groups.filter((g) =>
        gate === "any"
          ? ["affected", "needs_human", "check_by_hand"].includes(g.verdict)
          : gate === "deadline"
            ? g.verdict === "affected" && g.deadline !== null && Date.parse(g.deadline) <= horizon
            : g.verdict === "affected",
      );
      if (values.json)
        process.stdout.write(
          `${JSON.stringify({ gate, within, failing: failing.map((g) => g.key), ...scanJson(scan) }, null, 2)}\n`,
        );
      else {
        process.stdout.write(`${renderScan(scan, { all: values.all })}\n`);
        process.stdout.write(
          failing.length
            ? `teire check: ${failing.length} change${failing.length === 1 ? "" : "s"} fail the "${gate}" gate\n`
            : `teire check: passes the "${gate}" gate\n`,
        );
      }
      process.exitCode = failing.length ? 1 : 0;
      return;
    }
    case "explain": {
      const id = positionals[0];
      if (!id) fail("explain needs a change id (from `teire scan --json` or `teire changes`)");
      const record = await getChange(base, id);
      if (!record) fail(`no public change with id ${id} in ${base}`);
      process.stdout.write(
        values.json ? `${JSON.stringify(record, null, 2)}\n` : `${renderChange(record)}\n`,
      );
      return;
    }
    case "changes": {
      const filters = {
        ...(values.provider ? { provider: values.provider } : {}),
        ...(values.ecosystem ? { ecosystem: values.ecosystem } : {}),
        ...(values.kind ? { kind: values.kind } : {}),
        ...(values.subject ? { subject: values.subject } : {}),
      };
      const changes = await listChanges(base, filters);
      if (values.json) process.stdout.write(`${JSON.stringify(changes, null, 2)}\n`);
      else
        for (const r of changes)
          process.stdout.write(
            `${r.applicability.effectiveOn?.slice(0, 10) ?? "          "}  ${r.title}\n            ${r.id}\n`,
          );
      return;
    }
    case "mcp":
      await serveMcp(scanOptions);
      return;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${TEIRE_VERSION}\n`);
      return;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    default:
      fail(`unknown command ${command}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`teire: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
