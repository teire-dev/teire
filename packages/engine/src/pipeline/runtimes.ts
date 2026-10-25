import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { RUNTIMES } from "../constants";
import { type ChangeV2, changeV2 } from "../contract";
import type { FindingDraft } from "../impact";
import type { JsProject } from "../inventory/js";
import { readJsUpgradePolicy } from "../inventory/js-policy";
import type { PyProject } from "../inventory/python";
import type { RepoTree } from "../inventory/tree";
import type { RegistryOptions } from "../registry/clients";
import { getRuntimeProduct, RUNTIME_PRODUCTS, type RuntimeRelease } from "../registry/eol";

/**
 * Runtime end of life (plan S04, feature 2): the runtime a repo actually runs, read from its own
 * files, against endoflife.date's support dates. A release line past its end of life gets no
 * security fixes, and hosting platforms retire it; a line within RUNTIMES.warnDays of it is
 * flagged ahead. These are notices (D76): nothing in the code breaks on the date, so no PR opens on
 * them; they appear in the onboarding table and the dashboard with the line to move to.
 */
export interface RuntimeUse {
  runtime: keyof typeof RUNTIME_PRODUCTS;
  /** Release line as endoflife.date names it (`20`, `3.9`). */
  line: string;
  file: string;
  /** 1-based line in `file` that sets it. */
  lineNo: number;
  snippet: string;
}

function locate(tree: RepoTree, file: string, needle: RegExp) {
  const lines = (tree.read(file) ?? "").split("\n");
  const i = Math.max(
    0,
    lines.findIndex((l) => needle.test(l)),
  );
  return { lineNo: i + 1, snippet: (lines[i] ?? "").trim().slice(0, 200) };
}

export function runtimesOf(tree: RepoTree, js: JsProject[], py: PyProject[]): RuntimeUse[] {
  const out: RuntimeUse[] = [];
  for (const project of js) {
    const node = readJsUpgradePolicy(tree, project).node;
    if (!node) continue;
    const file = node.source.split(" ")[0] ?? node.source;
    // package.json: the `engines.node` line (its own "version" has digits too); .nvmrc and friends: the version.
    const pattern = file.endsWith("package.json") ? /"node"\s*:/ : /\d/;
    out.push({ runtime: "node", line: String(node.major), file, ...locate(tree, file, pattern) });
  }
  for (const project of py) {
    const versionFile = [join(project.root, ".python-version"), ".python-version"].find(
      (f) => tree.read(f) !== null,
    );
    const pinned = versionFile ? /^\s*(\d+\.\d+)/.exec(tree.read(versionFile) ?? "")?.[1] : undefined;
    if (versionFile && pinned) {
      out.push({ runtime: "python", line: pinned, file: versionFile, ...locate(tree, versionFile, /\d/) });
      continue;
    }
    const pyproject = join(project.root, "pyproject.toml");
    const text = tree.read(pyproject);
    if (!text) continue;
    let requires: unknown;
    try {
      requires = (parseToml(text) as { project?: { "requires-python"?: unknown } }).project?.[
        "requires-python"
      ];
    } catch {
      continue;
    }
    const floor = typeof requires === "string" ? />=\s*(\d+\.\d+)/.exec(requires)?.[1] : undefined;
    if (floor)
      out.push({
        runtime: "python",
        line: floor,
        file: pyproject,
        ...locate(tree, pyproject, /requires-python/),
      });
  }
  // One finding per runtime line and file.
  return out.filter(
    (u, i) => out.findIndex((x) => x.runtime === u.runtime && x.line === u.line && x.file === u.file) === i,
  );
}

function successor(releases: RuntimeRelease[], runtime: RuntimeUse["runtime"]) {
  const maintained = releases.filter((r) => r.maintained && (runtime !== "node" || r.lts));
  return maintained[0] ?? null;
}

export async function assessRuntimes(
  uses: RuntimeUse[],
  options: RegistryOptions,
): Promise<{ records: ChangeV2[]; findings: FindingDraft[] }> {
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + RUNTIMES.warnDays * 86_400_000).toISOString().slice(0, 10);
  const records: ChangeV2[] = [];
  const findings: FindingDraft[] = [];
  for (const use of uses) {
    const product = await getRuntimeProduct(RUNTIME_PRODUCTS[use.runtime], options).catch(() => null);
    const release = product?.releases.find((r) => r.line === use.line);
    if (!product || !release?.eolOn || release.eolOn > horizon) continue;
    const next = successor(product.releases, use.runtime);
    const past = release.eolOn <= today;
    const id = `runtime/${product.product}/${release.line}/eol`;
    const record = changeV2.parse({
      schemaVersion: 2,
      id,
      subject: { kind: "runtime", name: product.product },
      kind: "runtime-eol",
      title: `${product.label} ${release.line} ${past ? "reached" : "reaches"} end of life on ${release.eolOn}`,
      summary: `${product.label} ${release.line} ${past ? "has received no security fixes since" : "stops receiving security fixes on"} ${release.eolOn}.${next ? ` The current supported line is ${product.label} ${next.line}${next.lts ? " (LTS)" : ""}.` : ""}`,
      applicability: { class: "notice", affectedRange: release.line, effectiveOn: release.eolOn },
      replacement: next ? { value: `${product.label} ${next.line}`, modelIds: [] } : null,
      sources: [
        {
          url: `https://endoflife.date/${product.product}`,
          kind: "registry",
          trustBasis: "registry",
          contentHash: "0".repeat(64),
          checkedAt: product.source.checkedAt,
          tool: { name: "endoflife.date", version: "api-v1" },
        },
      ],
      provenance: { method: "feed", confidence: { overall: 1 } },
      visibility: "public",
      status: "confirmed",
    });
    if (!records.some((r) => r.id === id)) records.push(record);
    findings.push({
      changeId: id,
      changeKind: "runtime-eol",
      dependencyKey: `runtime:${use.runtime}:${use.file}`,
      verdict: "affected",
      class: "notice",
      reachability: "package-present",
      priority: null,
      position: {
        version: `${product.label} ${release.line}`,
        target: next ? `${product.label} ${next.line}` : null,
        isMajor: false,
      },
      callSites: [
        {
          file: use.file,
          line: use.lineNo,
          column: 1,
          kind: "config",
          snippet: use.snippet,
          resolution: "literal",
        },
      ],
      coverage: null,
      groupKey: `runtime/${use.runtime}`,
      reason: `${record.title}; set in ${use.file}.${next ? ` Move to ${product.label} ${next.line}.` : ""}`,
    });
  }
  return { records, findings };
}
