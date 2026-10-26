import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { changesFor, findChange } from "./catalog";
import { groupDetail, groupFindings, scanSummary } from "./render";
import { type ScanResult, scanPath } from "./scan";
import { resolveTarget } from "./target";

declare const TEIRE_VERSION: string;

/**
 * `teire mcp` (card C11): the CLI's tools for a coding agent over stdio. A scan is kept for a few
 * minutes per target (a folder, or a public GitHub repository), so `explain_finding` after
 * `scan_path` does not scan again. Stdout carries the protocol only; anything the engine logs goes
 * to stderr.
 */
const SCAN_TTL_MS = 5 * 60_000;

const text = (value: unknown) => ({
  content: [
    { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
});

export async function serveMcp(options: { catalogUrl: string; githubToken?: string }) {
  console.log = console.error;
  console.info = console.error;
  const scans = new Map<string, { at: number; scan: Promise<ScanResult> }>();
  const scanOf = (path: string, fresh = false, progress?: (step: string) => void) => {
    const key = path.trim();
    const kept = scans.get(key);
    if (kept && !fresh && Date.now() - kept.at < SCAN_TTL_MS) return kept.scan;
    const scan = (async () => {
      progress?.(`resolving ${key}`);
      const target = await resolveTarget(key, options.githubToken);
      try {
        return await scanPath(target.dir, {
          ...options,
          label: target.label,
          ...(target.github ? { origin: target.github } : {}),
          ...(progress ? { progress } : {}),
        });
      } finally {
        await target.cleanup();
      }
    })();
    scans.set(key, { at: Date.now(), scan });
    scan.catch(() => scans.delete(key));
    return scan;
  };
  // A large repository takes a minute or more: each step is a progress notification when the client
  // asked for them (a progress token), which also keeps clients that reset their timeout on progress.
  const progressOf = (extra: {
    _meta?: { progressToken?: string | number };
    sendNotification: (n: {
      method: "notifications/progress";
      params: { progressToken: string | number; progress: number; message: string };
    }) => Promise<void>;
  }) => {
    const token = extra._meta?.progressToken;
    if (token === undefined) return undefined;
    let step = 0;
    return (message: string) => {
      extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: ++step, message },
        })
        .catch(() => undefined);
    };
  };
  const failure = (error: unknown) => ({
    ...text(error instanceof Error ? error.message : String(error)),
    isError: true,
  });

  const server = new McpServer({ name: "teire", version: TEIRE_VERSION });
  server.registerTool(
    "scan_path",
    {
      title: "Scan a repository",
      description:
        "Scan a repository for dependency and API changes that affect it: every package across npm, PyPI, Go, Cargo, RubyGems and Maven/Gradle, the API hosts and model IDs the code calls, and runtime end-of-life dates. Works on a local folder or a public GitHub repository (downloaded, no clone). Returns the groups that need action (one per PR Teire would open) with verdict, priority, deadline and their first call sites; explain_finding gives one group in full. A large repository can take a minute or two.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "A folder (absolute, or relative to where the server runs), or a public GitHub repository as owner/name or its URL",
          ),
        fresh: z
          .boolean()
          .optional()
          .describe("Scan again even when a scan from the last five minutes is kept"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, fresh }, extra) => {
      try {
        return text(scanSummary(await scanOf(path, fresh ?? false, progressOf(extra))));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "explain_finding",
    {
      title: "Explain a finding",
      description:
        "One finding group from a scan (its `key` from scan_path, a change id, or a package name): its change records with summary, replacement, migration notes and quoted sources, and up to 50 call sites in the repo with their code (product code first, tests last).",
      inputSchema: {
        path: z.string().describe("The folder or GitHub repository given to scan_path"),
        key: z.string().describe("A group key from scan_path, a change id, or a package name"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, key }, extra) => {
      let scan: ScanResult;
      try {
        scan = await scanOf(path, false, progressOf(extra));
      } catch (error) {
        return failure(error);
      }
      const groups = groupFindings(scan);
      const group =
        groups.find((g) => g.key === key) ??
        groups.find((g) => g.findings.some((f) => f.changeId === key)) ??
        groups.find((g) => g.findings.some((f) => /^[^:]+:(.+?)@/.exec(f.dependencyKey)?.[1] === key));
      if (!group)
        return {
          ...text(`No finding for ${key} in ${scan.label}. Run scan_path to list the keys.`),
          isError: true,
        };
      return text(groupDetail(scan, group));
    },
  );
  server.registerTool(
    "list_changes",
    {
      title: "List public changes",
      description:
        "Confirmed changes Teire has read: API deprecations and shutdowns, model retirements, breaking package releases. From Teire's public catalog, or read live from the provider's own pages when the catalog doesn't hold them yet. Every record carries the exact source quote it was confirmed against.",
      inputSchema: {
        provider: z
          .string()
          .optional()
          .describe("Provider slug(s), comma-separated (openai, anthropic, stripe…)"),
        ecosystem: z.string().optional().describe("npm, pypi, go, cargo, rubygems or maven"),
        kind: z
          .string()
          .optional()
          .describe("Change kind, e.g. model-retirement, endpoint-removal, symbol-removed"),
        subject: z.string().optional().describe("Package or model name"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (filters) => {
      const notes: string[] = [];
      const changes = await changesFor(options.catalogUrl, filters, notes);
      const shown = 60;
      return text({
        ...(notes.length ? { notes } : {}),
        ...(changes.length > shown
          ? { total: changes.length, more: `${changes.length - shown} more; narrow with subject or kind` }
          : {}),
        changes: changes.slice(0, shown).map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          class: r.applicability.class,
          effectiveOn: r.applicability.effectiveOn ?? null,
          replacement: r.replacement?.value ?? null,
        })),
      });
    },
  );
  server.registerTool(
    "get_change",
    {
      title: "Get a change",
      description:
        "One change record by id: summary, what it applies to, the replacement, migration notes and quoted sources.",
      inputSchema: { id: z.string().describe("Change id from list_changes or scan_path") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      const record = await findChange(options.catalogUrl, id, []);
      return record
        ? text(record)
        : {
            ...text(
              `No change with id ${id}. Ids come from list_changes, or from scan_path for package changes (use explain_finding there).`,
            ),
            isError: true,
          };
    },
  );
  await server.connect(new StdioServerTransport());
}
