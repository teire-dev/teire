import { LineCounter, type Node, parseDocument } from "yaml";
import { z } from "zod";
import { PULL_REQUESTS, REGISTRY } from "../constants";
import type { RepoTree } from "../inventory/tree";

/**
 * `.github/teire.yml` (card C8, plan S09). The file is read leniently: a key with the wrong type
 * falls back to its default and is reported with its line number, never fatal. Values resolve repo
 * > org (`<org>/teire-config`) > defaults, and the source of each one is kept for `@teire config`.
 * The same zod schema yields the JSON Schema served at `/schema.json` for editors. Models,
 * endpoints and keys are not settable from a repo (rule 10).
 */
export const ECOSYSTEM_KEYS = ["npm", "pypi", "maven", "go", "cargo", "rubygems", "apis"] as const;

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const https = z.string().refine((v) => {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}, "must be an https URL");

const sourceSchema = z
  .object({
    host: z.string().regex(HOST, "must be a host name").optional(),
    package: z.string().min(1).optional(),
    changelogUrl: https.optional(),
    specUrl: https.optional(),
  })
  .strict()
  .refine(
    (s) => (s.host || s.package) && (s.changelogUrl || s.specUrl),
    "needs a host or package and an https changelogUrl or specUrl",
  );

export const teireConfigSchema = z
  .object({
    ecosystems: z
      .object(
        Object.fromEntries(ECOSYSTEM_KEYS.map((k) => [k, z.boolean()])) as Record<
          (typeof ECOSYSTEM_KEYS)[number],
          z.ZodBoolean
        >,
      )
      .partial()
      .strict()
      .describe("Turn an ecosystem (or API-host checks, `apis`) off for this repo; all are on by default."),
    paths: z.array(z.string()).describe("Only scan these paths (globs)."),
    ignorePaths: z.array(z.string()).describe("Never scan these paths (globs)."),
    ignore: z
      .array(z.string())
      .describe("Change ids, packages (`openai`, `npm:openai`) or providers (`provider:groq`) to ignore."),
    upgrades: z
      .object({
        majors: z.boolean().describe("Open PRs for new majors (default true)."),
        plainBumps: z.boolean().describe("Open PRs for upgrades with no located break (default true)."),
        cooldownDays: z.number().int().min(0).max(90).describe("Skip versions younger than this many days."),
        allow: z.array(z.string()).describe("Only upgrade these packages."),
        deny: z.array(z.string()).describe("Never upgrade these packages."),
      })
      .partial()
      .strict(),
    schedule: z
      .enum(["push", "daily", "weekly", "off"])
      .describe("When to rescan besides pushes that touch dependencies."),
    verify: z
      .array(
        z
          .object({
            workspace: z.string().describe("Project directory, `.` for the root."),
            install: z.string().optional(),
            typecheck: z.string().optional(),
            test: z.string().optional(),
          })
          .strict(),
      )
      .describe("Commands that replace the detected ones, per workspace."),
    pullRequests: z
      .object({
        limit: z.number().int().min(0).max(50).describe("Open Teire PRs at most (default 5)."),
        perHour: z.number().int().min(0).max(20).describe("New Teire PRs per hour at most (default 2)."),
        labels: z.array(z.string()).describe("Extra labels on every Teire PR."),
        commitMessage: z.object({ prefix: z.string() }).partial().strict(),
        targetBranch: z.string().describe("Base branch for PRs (default: the repo's default branch)."),
      })
      .partial()
      .strict(),
    dashboardIssue: z.boolean().describe("Keep the Teire Dashboard issue (default true)."),
    sources: z
      .array(sourceSchema)
      .describe("Changelogs or API specs Teire should read for a host or package."),
  })
  .partial()
  .strict();

/** The JSON Schema editors read (`# yaml-language-server: $schema=…/schema.json`). */
export const teireConfigJsonSchema = {
  $id: "https://teire.vercel.app/schema.json",
  title: "Teire configuration (.github/teire.yml)",
  ...z.toJSONSchema(teireConfigSchema),
};

export interface DeclaredSource {
  host?: string;
  package?: string;
  changelogUrl?: string;
  specUrl?: string;
}

export type ConfigOrigin = "repo" | "org" | "default";

export interface ConfigIssue {
  file: string;
  line: number;
  path: string;
  message: string;
}

export interface TeireConfig {
  present: boolean;
  path: string | null;
  ecosystems: Record<(typeof ECOSYSTEM_KEYS)[number], boolean>;
  paths: string[];
  ignorePaths: string[];
  upgrades: { majors: boolean; plainBumps: boolean; cooldownDays: number; allow: string[]; deny: string[] };
  schedule: "push" | "daily" | "weekly" | "off";
  verify: { workspace: string; install?: string; typecheck?: string; test?: string }[];
  pullRequests: {
    limit: number;
    perHour: number;
    labels: string[];
    commitMessage: { prefix: string };
    targetBranch: string | null;
  };
  dashboardIssue: boolean;
  ignore: string[];
  /** Sources the repo names itself (C8, D52); read through the same gate, `repo-config`, private. */
  sources: DeclaredSource[];
  /** Readable problems (`line 4: upgrades.cooldownDays …`), kept for the Dashboard issue and logs. */
  problems: string[];
  /** The same problems with positions, for the validation check run's annotations. */
  issues: ConfigIssue[];
  /** Where each top-level value came from: `upgrades.cooldownDays` → repo/org/default. */
  origins: Record<string, ConfigOrigin>;
}

export const CONFIG_PATHS = [".github/teire.yml", ".github/teire.yaml", "teire.yml", "teire.yaml"] as const;

export function defaultConfig(): TeireConfig {
  return {
    present: false,
    path: null,
    ecosystems: Object.fromEntries(ECOSYSTEM_KEYS.map((k) => [k, true])) as TeireConfig["ecosystems"],
    paths: [],
    ignorePaths: [],
    upgrades: { majors: true, plainBumps: true, cooldownDays: REGISTRY.cooldownDays, allow: [], deny: [] },
    schedule: "push",
    verify: [],
    pullRequests: {
      limit: PULL_REQUESTS.maxOpenPerRepo,
      perHour: PULL_REQUESTS.maxNewPerHour,
      labels: [],
      commitMessage: { prefix: "" },
      targetBranch: null,
    },
    dashboardIssue: true,
    ignore: [],
    sources: [],
    problems: [],
    issues: [],
    origins: {},
  };
}

/** Reads one file: the values that pass the schema, and every problem with its line. */
function readLayer(text: string, file: string) {
  const issues: ConfigIssue[] = [];
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  const lineAt = (node: Node | null | undefined) => (node?.range ? lines.linePos(node.range[0]).line : 1);
  for (const e of doc.errors)
    issues.push({
      file,
      line: e.linePos?.[0]?.line ?? 1,
      path: "",
      message: `not valid YAML: ${e.message.split("\n")[0]}`,
    });
  if (doc.errors.length) return { values: {} as Record<string, unknown>, issues };
  const raw = (doc.toJS() ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ file, line: 1, path: "", message: "must be a mapping of keys" });
    return { values: {}, issues };
  }
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = (teireConfigSchema.shape as Record<string, z.ZodType>)[key];
    if (!field) {
      issues.push({
        file,
        line: lineAt(doc.getIn([key], true) as Node),
        path: key,
        message: `unknown key "${key}"`,
      });
      continue;
    }
    const parsed = field.safeParse(value);
    if (parsed.success) {
      values[key] = parsed.data;
      continue;
    }
    // Partial keep for objects and lists: valid members stay, each bad one is reported at its line.
    for (const problem of parsed.error.issues) {
      const path = [key, ...problem.path.map(String)];
      const node = doc.getIn(path.slice(0, path.length), true) as Node | undefined;
      const at = node ?? (doc.getIn([key], true) as Node | undefined);
      issues.push({ file, line: lineAt(at), path: path.join("."), message: problem.message });
    }
    const salvage = salvageable(field, value);
    if (salvage !== undefined) values[key] = salvage;
  }
  return { values, issues };
}

/** The valid part of a value that failed as a whole: object members and list items that pass alone. */
function salvageable(field: z.ZodType, value: unknown): unknown {
  const inner = field instanceof z.ZodOptional ? (field.unwrap() as z.ZodType) : field;
  if (inner instanceof z.ZodObject && value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const member = (inner.shape as Record<string, z.ZodType>)[k];
      if (!member) continue;
      const parsed = member.safeParse(v);
      if (parsed.success) out[k] = parsed.data;
      else {
        const nested = salvageable(member, v);
        if (nested !== undefined) out[k] = nested;
      }
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (inner instanceof z.ZodArray && Array.isArray(value)) {
    const element = inner.element as z.ZodType;
    const kept = value.filter((v) => element.safeParse(v).success);
    return kept;
  }
  return undefined;
}

/** Applies one layer's values onto the config, recording the origin of each leaf it sets. */
function apply(config: TeireConfig, values: Record<string, unknown>, origin: ConfigOrigin) {
  const target = config as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    const current = target[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const slot = (current as Record<string, unknown>)[k];
        if (v && typeof v === "object" && !Array.isArray(v) && slot && typeof slot === "object")
          Object.assign(slot, v);
        else (current as Record<string, unknown>)[k] = v;
        config.origins[`${key}.${k}`] = origin;
      }
    } else {
      target[key] = value;
      config.origins[key] = origin;
    }
  }
}

/**
 * The resolved config. `orgText` is `<org>/teire-config`'s `teire.yml`, when the org has one; its
 * problems are reported against that file. Org `ignore` and `sources` lists add to the repo's.
 */
export function readTeireConfig(
  tree: RepoTree,
  options: { orgText?: string | null; orgFile?: string } = {},
): TeireConfig {
  const config = defaultConfig();
  const report = (layerIssues: ConfigIssue[]) => {
    config.issues.push(...layerIssues);
    config.problems.push(
      ...layerIssues.map((i) => `${i.file} line ${i.line}: ${i.path ? `${i.path} ` : ""}${i.message}`),
    );
  };
  let orgValues: Record<string, unknown> = {};
  if (options.orgText) {
    const org = readLayer(options.orgText, options.orgFile ?? "teire-config/teire.yml");
    report(org.issues);
    orgValues = org.values;
    apply(config, org.values, "org");
  }
  const path = CONFIG_PATHS.find((p) => tree.read(p) !== null) ?? null;
  if (path) {
    config.present = true;
    config.path = path;
    const repo = readLayer(tree.read(path) ?? "", path);
    report(repo.issues);
    const values = { ...repo.values };
    // Lists that accumulate: the org's ignores and sources stay, the repo's add to them.
    for (const k of ["ignore", "sources"] as const)
      if (Array.isArray(values[k]) && Array.isArray(orgValues[k]))
        values[k] = [...(orgValues[k] as unknown[]), ...(values[k] as unknown[])];
    apply(config, values, "repo");
  }
  for (const key of Object.keys(defaultConfig()))
    if (
      !["present", "path", "problems", "issues", "origins"].includes(key) &&
      !Object.keys(config.origins).some((o) => o === key || o.startsWith(`${key}.`))
    )
      config.origins[key] = "default";
  return config;
}

/** `@teire config`: every resolved value with where it came from. */
export function describeConfig(config: TeireConfig) {
  const rows: string[] = [];
  const walk = (prefix: string, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, v);
      return;
    }
    const top = prefix.split(".")[0] as string;
    const origin =
      config.origins[prefix] ??
      config.origins[prefix.split(".").slice(0, 2).join(".")] ??
      config.origins[top] ??
      "default";
    rows.push(`| \`${prefix}\` | \`${JSON.stringify(value)}\` | ${origin} |`);
  };
  for (const [k, v] of Object.entries(config))
    if (!["present", "path", "problems", "issues", "origins"].includes(k)) walk(k, v);
  return ["| Key | Value | From |", "|---|---|---|", ...rows].join("\n");
}
