import "./env";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { catalogUrl, changesFor, findChange } from "./catalog";
import { serveMcp } from "./mcp";
import { groupFindings, renderChange, renderScan, scanJson } from "./render";
import { type ScanResult, scanPath } from "./scan";
import { resolveTarget } from "./target";

declare const TEIRE_VERSION: string;

const HELP = `teire — every dependency and API change that affects your code, from the terminal

Run it with npx:  npx teire-cli <command>
Or install it:    npm install -g teire-cli   then   teire <command>

Commands
  scan [target] [--json] [--all]       What changed upstream that reaches your code. The target is a
                                       folder (default: the current one), or a public GitHub
                                       repository as owner/name or its URL, downloaded, no clone
  check [target] [--fail-on affected|deadline|any] [--within 90]
                                       The same scan as a CI gate: exit 1 when it fails
  explain <change-id> [target]         One change: summary, replacement, migration notes and the
                                       quoted source (ids come from scan --json or changes)
  changes [--provider openai,...] [--ecosystem e] [--kind k] [--subject s] [--json]
                                       Changes Teire has read: model retirements, API shutdowns,
                                       breaking releases
  mcp                                  Serve the same tools to coding agents over MCP (stdio):
                                       claude mcp add teire -- npx -y teire-cli mcp

Examples
  npx teire-cli scan                   the project in this folder
  npx teire-cli scan vercel/ai-chatbot a public repository, without cloning it
  npx teire-cli changes --provider openai
  npx teire-cli check --fail-on deadline --within 60

Environment (all optional)
  GITHUB_TOKEN           Higher GitHub rate limits (release notes, advisories, private repositories)
  TOKENFACTORY_API_KEY   Trace model IDs kept in config or registries with Nemotron, as the service does
  TAVILY_API_KEY         Find the notices of an API host Teire has not discovered yet
  TEIRE_URL              Another Teire deployment (default https://teire.vercel.app)

Docs: https://teire.vercel.app/docs/build/cli
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
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const base = catalogUrl();
  const token = process.env.GITHUB_TOKEN || undefined;
  const scanOptions = { catalogUrl: base, ...(token ? { githubToken: token } : {}) };
  // In a terminal, one line that updates in place; in CI logs, one line per step.
  const tty = Boolean(process.stderr.isTTY);
  const progress = (step: string) =>
    process.stderr.write(
      tty
        ? `\r\x1b[2K${`teire: ${step}…`.slice(0, (process.stderr.columns || 80) - 1)}`
        : `teire: ${step}…\n`,
    );
  /** A folder, or a public GitHub repository downloaded for the scan and removed after it. */
  const scanTarget = async (arg: string | undefined): Promise<ScanResult> => {
    if (arg && !existsSync(arg)) progress(`downloading ${arg} from GitHub`);
    const target = await resolveTarget(arg, token);
    if (tty) process.stderr.write("\r\x1b[2K");
    if (target.github) process.stderr.write(`teire: downloaded ${target.label}\n`);
    try {
      return await scanPath(target.dir, {
        ...scanOptions,
        label: target.label,
        progress,
        ...(target.github ? { origin: target.github } : {}),
      });
    } finally {
      if (tty) process.stderr.write("\r\x1b[2K");
      await target.cleanup();
    }
  };
  const notes: string[] = [];
  const printNotes = () => {
    for (const n of notes) process.stderr.write(`${n}\n`);
  };
  switch (command) {
    case "scan": {
      const scan = await scanTarget(positionals[0]);
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
      const scan = await scanTarget(positionals[0]);
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
      let record = await findChange(base, id, notes);
      // A package change Teire computed (npm/openai/4.104.0..7.38.0/symbol-removed) lives in the scan
      // that found it: scan the target again and read it from there.
      if (!record && id.includes("/")) {
        notes.push("Not in the public catalog; reading it from a scan of the target.");
        record = (await scanTarget(positionals[1])).records.get(id) ?? null;
      }
      printNotes();
      if (!record)
        fail(
          `no change with id ${id}. Ids come from \`teire changes\`, or from \`teire scan --json\` in the project that has it`,
        );
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
      const changes = await changesFor(base, filters, notes);
      printNotes();
      if (values.json) process.stdout.write(`${JSON.stringify(changes, null, 2)}\n`);
      else if (!changes.length) process.stdout.write("No changes match.\n");
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
