import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import YAML from "yaml";
import { type ProviderRecord, slugify } from "../catalog/schema";
import { sha256 } from "../catalog/source";
import { OPENAPI } from "../constants";
import { type ChangeKindV2, type ChangeV2, changeV2 } from "../contract";
import { isApiEndpoint, linkScope, registrableDomain } from "../discover/domains";
import { type FindingDraft, priorityOf } from "../impact";
import type { RepoTree } from "../inventory/tree";
import type { LiteralHit } from "../locate/literals";
import { guardedFetch } from "../net/fetch";
import type { RegistryOptions } from "../registry/clients";
import { indexSpec, matchOperations, type SpecOperation } from "./match";
import { type OasdiffItem, oasdiffBreaking } from "./oasdiff";
import { findSpec, lastChangedAt, type SpecLocation, specRevision, specText } from "./spec";

export * from "./match";
export * from "./oasdiff";
export * from "./spec";

/**
 * OpenAPI diffs for the APIs a repo calls over HTTP (plan S04, feature 2, research cross-cutting.md
 * §5). The repo's position on an API, like a lockfile version for a package:
 *  - the API version it pins (`Stripe-Version: 2024-06-20`, `apiVersion: "2024-06-20"`): changes
 *    since then break it when it moves to the latest version;
 *  - otherwise the date its call-site file last changed: an unversioned API that changed since then
 *    has already changed under it.
 * oasdiff (pinned) compares the provider's own spec at that position with the latest; only errors
 * on operations the repo's URLs reach become findings, everything else is context.
 */
export interface OpenApiOptions extends RegistryOptions {
  githubToken?: string;
  /** The scanned repo on GitHub, for the history of its call-site files. */
  repo?: { owner: string; name: string; sha: string };
  /** Specs the repo names in teire.yml, as GitHub file URLs (their history gives the revisions). */
  declared?: { host: string; specUrl: string }[];
}

/** `https://github.com/o/r/blob/<branch>/<path>` or `https://raw.githubusercontent.com/o/r/<branch>/<path>`. */
export function githubSpecLocation(url: string): SpecLocation | null {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  if (u.hostname === "github.com" && parts[2] === "blob" && parts.length >= 5)
    return { repo: `${parts[0]}/${parts[1]}`, branch: parts[3] as string, path: parts.slice(4).join("/") };
  if (u.hostname === "raw.githubusercontent.com" && parts.length >= 4)
    return { repo: `${parts[0]}/${parts[1]}`, branch: parts[2] as string, path: parts.slice(3).join("/") };
  return null;
}

export interface OpenApiAssessment {
  records: ChangeV2[];
  findings: FindingDraft[];
  /** Per host: what was compared, or why nothing was. */
  notes: string[];
}

/** `apiVersion: "2024-06-20"`, `"Stripe-Version": "2024-06-20.acacia"`, `api_version="2024-06-20"`. */
const PIN =
  /\b(?:api[_-]?version|apiVersion|[\w-]*-version|stripe_version)["'`]?\s*(?:[:=]|=>|,)\s*["'`](\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?)["'`]/gi;

export function pinnedApiVersion(repoDir: string, files: string[]): { version: string; file: string } | null {
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, file), "utf8");
    } catch {
      continue;
    }
    const m = PIN.exec(text);
    PIN.lastIndex = 0;
    if (m?.[1]) return { version: m[1], file };
  }
  return null;
}

/** The GitHub organisation that owns one of the provider's SDKs, from the registry's own metadata. */
async function sdkOwner(provider: ProviderRecord, options: RegistryOptions): Promise<string | null> {
  for (const sdk of provider.sdks) {
    // npm's and PyPI's metadata name the repository; one SDK's owner is enough.
    if (sdk.ecosystem !== "npm" && sdk.ecosystem !== "pypi") continue;
    const key = `${sdk.ecosystem}:${sdk.name}:repo`;
    const cached = await options.cache.get("sdk-profile", key);
    let links: string[];
    if (cached) links = cached.data as string[];
    else {
      try {
        const url =
          sdk.ecosystem === "npm"
            ? `https://registry.npmjs.org/${sdk.name.replace("/", "%2F")}/latest`
            : `https://pypi.org/pypi/${encodeURIComponent(sdk.name)}/json`;
        const res = await guardedFetch(url, { allowHosts: ["registry.npmjs.org", "pypi.org"] });
        if (res.status !== 200) continue;
        const doc = res.json<{
          repository?: string | { url?: string };
          homepage?: string;
          info?: { project_urls?: Record<string, string> | null; home_page?: string | null };
        }>();
        links = [
          typeof doc.repository === "string" ? doc.repository : doc.repository?.url,
          doc.homepage,
          ...Object.values(doc.info?.project_urls ?? {}),
          doc.info?.home_page,
        ].filter((x): x is string => !!x);
      } catch {
        continue;
      }
      await options.cache.put("sdk-profile", key, {
        etag: null,
        lastModified: null,
        bodyHash: sha256(JSON.stringify(links)),
        data: links,
        fetchedAt: new Date().toISOString(),
      });
    }
    for (const link of links) {
      const scope = linkScope(link);
      if (scope && "repoPrefix" in scope) return scope.repoPrefix.split("/")[1] ?? null;
    }
  }
  return null;
}

function kindOf(id: string): ChangeKindV2 {
  if (/^(?:api-path-removed|api-removed|endpoint-removed)/.test(id)) return "endpoint-removal";
  if (/^new-required-request|request-property-became-required|request-parameter-became-required/.test(id))
    return id.includes("became") ? "optional-to-required" : "required-added";
  if (
    /^request-(?:property|parameter)-removed|request-(?:property|parameter)-type-changed|enum-value-removed/.test(
      id,
    )
  )
    return "parameter-change";
  return "behaviour-change";
}

/**
 * A response change deep inside an expansion (`data/items/…/anyOf[…]/…/mandate`): Stripe repeats one
 * schema change through every path that can embed it. Code reads the fields near the top of a
 * response; request changes and shallow response changes are kept.
 */
export function deepResponseChange(item: Pick<OasdiffItem, "id" | "text">) {
  if (!item.id.startsWith("response-")) return false;
  const path = /`([^`]+)`/.exec(item.text)?.[1] ?? "";
  return (
    path.includes("anyOf[") || path.includes("oneOf[") || path.split("/").length > OPENAPI.maxResponseDepth
  );
}

const opKey = (method: string, path: string) => `${method.toUpperCase()} ${path.replace(/\?.*$/, "")}`;

export async function assessOpenApi(input: {
  repoDir: string;
  tree: RepoTree;
  hits: LiteralHit[];
  providers: { provider: ProviderRecord }[];
  options: OpenApiOptions;
  now?: Date;
}): Promise<OpenApiAssessment> {
  const now = input.now ?? new Date();
  const out: OpenApiAssessment = { records: [], findings: [], notes: [] };
  const byHost = new Map<string, LiteralHit[]>();
  for (const h of input.hits)
    if (h.kind === "url" && h.host && h.path && h.path !== "/" && isApiEndpoint(h.host, h.path))
      byHost.set(h.host, [...(byHost.get(h.host) ?? []), h]);

  // One host's failure (a GitHub outage, a spec that will not parse) skips that host, not the scan.
  const assessHost = async (host: string, hits: LiteralHit[]) => {
    const declared = input.options.declared?.find((d) => d.host === host);
    const domain = registrableDomain(host);
    const use = input.providers.find(
      (p) =>
        p.provider.detection.baseUrls.includes(host) ||
        (domain && p.provider.officialDomains.some((d) => registrableDomain(d) === domain)),
    );
    if (!use && !declared) {
      out.notes.push(`${host}: no provider SDK names where its API description lives`);
      return;
    }
    const provider = use?.provider ?? { slug: slugify(host), name: host, apiVersionHeader: undefined };
    const declaredAt = declared ? githubSpecLocation(declared.specUrl) : null;
    if (declared && !declaredAt) {
      out.notes.push(
        `${host}: teire.yml specUrl must be a GitHub file URL, so its history gives the revisions`,
      );
      return;
    }
    const owner = declaredAt || !use ? null : await sdkOwner(use.provider, input.options);
    const location: SpecLocation | null =
      declaredAt ?? (owner ? await findSpec(owner, host, input.options) : null);
    if (!location) {
      out.notes.push(`${host}: no API description found${owner ? ` in github.com/${owner}` : ""}`);
      return;
    }
    const head = await specRevision(location, input.options);
    if (!head) return;
    const headText = await specText(head.url);
    const headSpec = (
      location.path.endsWith(".json") ? JSON.parse(headText) : YAML.parse(headText)
    ) as Parameters<typeof indexSpec>[0] & { info?: { version?: string } };
    const index = indexSpec(headSpec);
    if (index.hosts.length && !index.hosts.includes(host)) {
      out.notes.push(`${host}: ${location.repo}/${location.path} describes ${index.hosts.join(", ")}`);
      return;
    }
    // The operations this repo's URLs reach, and the sites that reach each.
    const reached = new Map<string, { op: SpecOperation; sites: LiteralHit[] }>();
    for (const h of hits)
      for (const op of matchOperations(index, h.path ?? "/")) {
        const key = opKey(op.method, op.path);
        const entry = reached.get(key) ?? { op, sites: [] };
        if (!entry.sites.includes(h)) entry.sites.push(h);
        reached.set(key, entry);
      }
    if (!reached.size) {
      out.notes.push(`${host}: no call matches an operation in ${location.repo}/${location.path}`);
      return;
    }

    // The repo's position on this API: the version it pins, else when its calls were last written.
    const files = [...new Set(hits.map((h) => h.file))];
    const pin = pinnedApiVersion(
      input.repoDir,
      [...files, ...input.tree.files().filter((f) => !files.includes(f))].slice(0, 400),
    );
    let baseDate: string | null = pin ? `${pin.version.slice(0, 10)}T23:59:59Z` : null;
    if (!baseDate && input.options.repo) {
      const dates = (
        await Promise.all(
          files.map((f) =>
            lastChangedAt(input.options.repo as NonNullable<OpenApiOptions["repo"]>, f, input.options),
          ),
        )
      ).filter((d): d is string => !!d);
      baseDate = dates.sort()[0] ?? null;
    }
    if (!baseDate) {
      out.notes.push(`${host}: no pinned API version and no history for the calling files`);
      return;
    }
    const base = await specRevision(location, input.options, baseDate);
    if (!base || base.sha === head.sha) {
      out.notes.push(`${host}: ${location.repo}/${location.path} unchanged since ${baseDate.slice(0, 10)}`);
      return;
    }

    const diffKey = `${location.repo}:${location.path}:${base.sha}..${head.sha}:${OPENAPI.oasdiff.version}`;
    const cached = await input.options.cache.get("openapi", diffKey);
    let items: OasdiffItem[];
    if (cached) items = cached.data as OasdiffItem[];
    else {
      const baseText = await specText(base.url);
      const scratch = await mkdtemp(join(tmpdir(), "teire-spec-"));
      try {
        const ext = extname(location.path) || ".json";
        await writeFile(join(scratch, `base${ext}`), baseText);
        await writeFile(join(scratch, `head${ext}`), headText);
        items = await oasdiffBreaking(join(scratch, `base${ext}`), join(scratch, `head${ext}`));
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      await input.options.cache.put("openapi", diffKey, {
        etag: null,
        lastModified: null,
        bodyHash: sha256(JSON.stringify(items)),
        data: items,
        fetchedAt: now.toISOString(),
      });
    }

    const slug = provider.slug;
    const position = pin ? pin.version : base.date.slice(0, 10);
    const latest = headSpec.info?.version ?? head.date.slice(0, 10);
    const perOp = new Map<string, number>();
    for (const item of items) {
      if (!item.operation || !item.path || deepResponseChange(item)) continue;
      const key = opKey(item.operation, item.path);
      const hit = reached.get(key);
      if (!hit || (perOp.get(key) ?? 0) >= OPENAPI.maxItemsPerOperation) continue;
      perOp.set(key, (perOp.get(key) ?? 0) + 1);
      const record = changeV2.parse({
        schemaVersion: 2,
        id: `api/${host}/${key.replace(/\s+/, " ")}/${item.id}/${sha256(item.text).slice(0, 10)}`,
        subject: { kind: "api-host", name: host, provider: slug },
        kind: kindOf(item.id),
        title: `${key}: ${item.text}`.slice(0, 200),
        summary: `${item.text} (${item.id}, between ${location.repo} at ${base.sha.slice(0, 7)} and ${head.sha.slice(0, 7)})`,
        applicability: {
          class: pin ? "breaks-on-upgrade" : "already-broken",
          fromVersion: position,
          toVersion: latest,
          ...(pin
            ? {
                apiVersion: {
                  ...(provider.apiVersionHeader ? { header: provider.apiVersionHeader } : {}),
                  from: pin.version,
                  to: latest,
                },
              }
            : {}),
          announcedOn: head.date.slice(0, 10),
        },
        signatures: [
          {
            kind: "http-operation",
            method: hit.op.method,
            pathPattern: hit.op.path,
            hostPattern: host,
            ...(hit.op.operationId ? { operationId: hit.op.operationId } : {}),
          },
        ],
        sources: [
          {
            url: `https://github.com/${location.repo}/blob/${head.sha}/${location.path}`,
            kind: "openapi-diff",
            trustBasis: "source-repo",
            contentHash: sha256(headText),
            checkedAt: now.toISOString(),
            tool: { name: "oasdiff", version: OPENAPI.oasdiff.version },
          },
        ],
        provenance: {
          method: "tool",
          tool: { name: "oasdiff", version: OPENAPI.oasdiff.version, noiseFilterVersion: "1" },
          confidence: { overall: 0.9 },
        },
        visibility: "public",
        status: "confirmed",
      });
      out.records.push(record);
      out.findings.push({
        changeId: record.id,
        changeKind: record.kind,
        dependencyKey: `api:${host}${hit.op.path}`,
        verdict: "affected",
        class: record.applicability.class,
        reachability: "function-reachable",
        priority: priorityOf(record, "affected", now),
        position: { version: position, target: latest, isMajor: false },
        callSites: hit.sites.map((s) => ({
          file: s.file,
          line: s.line,
          column: s.column + 1,
          kind: "literal",
          snippet: s.snippet,
          resolution: "literal",
        })),
        coverage: null,
        groupKey: `api/${slug}`,
        reason: `${key} ${pin ? `differs between the pinned API version ${pin.version} and ${latest}` : `changed in ${provider.name}'s API description since ${position}`}: ${item.text}.`,
      });
    }
    out.notes.push(
      `${host}: ${location.repo}/${location.path} ${base.sha.slice(0, 7)} (${position}) → ${head.sha.slice(0, 7)} (${latest}): ${items.length} breaking item(s), ${out.findings.length} on operations this repo calls`,
    );
  };
  for (const [host, hits] of byHost)
    await assessHost(host, hits).catch((error: unknown) => {
      out.notes.push(
        `${host}: OpenAPI comparison failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  return out;
}
