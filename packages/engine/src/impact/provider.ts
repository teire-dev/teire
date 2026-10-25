import type { CallSite, ChangeV2, Coverage } from "../contract";
import type { LiteralContext, LiteralHit, LiteralScan } from "../locate/literals";
import { type FindingDraft, priorityOf } from "./index";

/**
 * Findings for API changes a provider announced (plan S04): a retired or rerouted model whose ID
 * the repo passes as a literal, an endpoint the repo calls by URL. One finding per change and per
 * model ID or endpoint used, so each can be fixed and tracked on its own. A literal whose context
 * says it is a model (an LLM call's argument, a model-named variable, a model key in config) makes
 * the repo affected; an ID that only appears elsewhere (a label, a log line) is inconclusive, listed
 * for a human. Removed request parameters (`call-arg`) are matched in a later step.
 */
const DECISIVE: ReadonlySet<LiteralContext> = new Set(["llm-call-arg", "model-variable", "config"]);

function siteOf(hit: LiteralHit): CallSite {
  return {
    file: hit.file,
    line: hit.line,
    column: hit.column + 1,
    kind: hit.context === "config" ? "config" : "literal",
    snippet: hit.snippet,
    resolution: "literal",
  };
}

export function coverageOf(scan: LiteralScan, unresolved: number): Coverage {
  return {
    filesScanned: scan.filesScanned,
    filesSkipped: [],
    languages: scan.languages,
    resolutionLevel: "syntax",
    unresolvedSites: unresolved,
    transitiveAnalysed: false,
  };
}

/** The pull request group for a provider's changes: one PR swaps every retired model of that provider. */
export function providerGroupKey(record: ChangeV2) {
  return `${record.subject.kind === "model" ? "models" : "api"}/${record.subject.provider ?? record.subject.name}`;
}

export function assessProviderChanges(input: {
  records: ChangeV2[];
  scan: LiteralScan;
  now?: Date;
}): FindingDraft[] {
  const now = input.now ?? new Date();
  const findings: FindingDraft[] = [];
  const models = new Map<string, LiteralHit[]>();
  for (const hit of input.scan.hits)
    if (hit.kind === "model") models.set(hit.value, [...(models.get(hit.value) ?? []), hit]);
  const urls = input.scan.hits.filter((h) => h.kind === "url" && h.host && h.path);

  for (const record of input.records) {
    if (record.status !== "confirmed") continue;
    const effective = record.applicability.effectiveOn;
    const replacement = record.replacement?.modelIds[0] ?? record.replacement?.value ?? null;
    for (const s of record.signatures) {
      let hits: LiteralHit[] = [];
      let key = "";
      if (s.kind === "string-literal") {
        hits = models.get(s.value) ?? [];
        key = `model:${s.value}`;
      } else if (s.kind === "http-operation") {
        hits = urls.filter(
          (h) =>
            h.host === s.hostPattern && (h.path === s.pathPattern || h.path?.startsWith(`${s.pathPattern}/`)),
        );
        key = `api:${s.hostPattern}${s.pathPattern}`;
      }
      if (!hits.length) continue;
      const decisive = hits.filter((h) => h.kind === "url" || DECISIVE.has(h.context));
      const verdict = decisive.length ? "affected" : "inconclusive";
      const what =
        s.kind === "string-literal"
          ? s.value
          : s.kind === "http-operation"
            ? `${s.hostPattern}${s.pathPattern}`
            : "";
      const when =
        record.applicability.class === "already-broken"
          ? `stopped working on ${effective}`
          : record.applicability.class === "breaks-on-date"
            ? `stops working on ${effective}`
            : record.kind === "model-rerouted"
              ? "is now served by another model"
              : "is deprecated";
      findings.push({
        changeId: record.id,
        changeKind: record.kind,
        dependencyKey: key,
        verdict,
        class: record.applicability.class,
        reachability: verdict === "affected" ? "function-reachable" : "reachability-unknown",
        priority: priorityOf(record, verdict, now),
        position: { version: what, target: replacement, isMajor: false },
        callSites: (verdict === "affected" ? decisive : hits).map(siteOf),
        coverage: coverageOf(input.scan, hits.length - decisive.length),
        groupKey: providerGroupKey(record),
        reason: `${what} ${when}${replacement ? `; the provider names ${replacement}` : ""}. ${
          verdict === "affected"
            ? `${decisive.length} use(s) as a model or endpoint`
            : `${hits.length} mention(s), none passed as a model: check by hand`
        }.`,
      });
    }
  }
  return findings;
}
