import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getChange, listChanges } from "./catalog";
import { groupFindings, scanJson } from "./render";
import { type ScanResult, scanPath } from "./scan";

declare const TEIRE_VERSION: string;

/**
 * `teire mcp` (card C11): the CLI's tools for a coding agent over stdio. A scan is kept for a few
 * minutes per path, so `explain_finding` after `scan_path` does not scan again. Stdout carries the
 * protocol only; anything the engine logs goes to stderr.
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
  const scanOf = (path: string, fresh = false) => {
    const dir = resolve(path);
    const kept = scans.get(dir);
    if (kept && !fresh && Date.now() - kept.at < SCAN_TTL_MS) return kept.scan;
    const scan = scanPath(dir, options);
    scans.set(dir, { at: Date.now(), scan });
    scan.catch(() => scans.delete(dir));
    return scan;
  };

  const server = new McpServer({ name: "teire", version: TEIRE_VERSION });
  server.registerTool(
    "scan_path",
    {
      title: "Scan a checkout",
      description:
        "Scan a local repository for dependency and API changes that affect it: every package across npm, PyPI, Go, Cargo, RubyGems and Maven/Gradle, the API hosts and model IDs the code calls, and runtime end-of-life dates. Returns findings grouped as Teire opens PRs, each with its verdict, priority, deadline and the exact call sites.",
      inputSchema: {
        path: z
          .string()
          .describe("Directory of the checkout (absolute, or relative to where the server runs)"),
        fresh: z
          .boolean()
          .optional()
          .describe("Scan again even when a scan from the last five minutes is kept"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, fresh }) => {
      const scan = await scanOf(path, fresh ?? false);
      const { changes: _, ...summary } = scanJson(scan);
      return text(summary);
    },
  );
  server.registerTool(
    "explain_finding",
    {
      title: "Explain a finding",
      description:
        "One finding group from a scan (its `key` from scan_path, a change id, or a package name): the change record with its quoted sources and migration notes, and every call site in the repo it reaches.",
      inputSchema: {
        path: z.string().describe("The scanned checkout"),
        key: z.string().describe("A group key from scan_path, a change id, or a package name"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, key }) => {
      const scan = await scanOf(path);
      const groups = groupFindings(scan);
      const group =
        groups.find((g) => g.key === key) ??
        groups.find((g) => g.findings.some((f) => f.changeId === key)) ??
        groups.find((g) => g.findings.some((f) => /^[^:]+:(.+?)@/.exec(f.dependencyKey)?.[1] === key));
      if (!group)
        return {
          ...text(`No finding for ${key} in ${resolve(path)}. Run scan_path to list the keys.`),
          isError: true,
        };
      const ids = [...new Set(group.findings.map((f) => f.changeId))];
      return text({ ...group, changes: ids.map((id) => scan.records.get(id)).filter(Boolean) });
    },
  );
  server.registerTool(
    "list_changes",
    {
      title: "List public changes",
      description:
        "Confirmed changes in Teire's public catalog: API deprecations and shutdowns, model retirements, breaking package releases. Every record carries the exact source quote it was confirmed against.",
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
      const changes = await listChanges(options.catalogUrl, filters);
      return text(
        changes.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          class: r.applicability.class,
          effectiveOn: r.applicability.effectiveOn ?? null,
          replacement: r.replacement?.value ?? null,
        })),
      );
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
      const record = await getChange(options.catalogUrl, id);
      return record ? text(record) : { ...text(`No public change with id ${id}`), isError: true };
    },
  );
  await server.connect(new StdioServerTransport());
}
