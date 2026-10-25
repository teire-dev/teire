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
    // One named model is the swap target; several are a choice, stated as the provider wrote it.
    const ids = record.replacement?.modelIds ?? [];
    const replacement = ids.length === 1 ? (ids[0] ?? null) : (record.replacement?.value ?? null);
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

/**
 * `*_BASE_URL` → inconclusive (card C3): when the deployment sets the base URL of a provider's client
 * (`OPENAI_BASE_URL`), a gateway or another provider may serve the request, so a retired model ID is
 * a question for a human, not a PR. The variable belongs to the provider whose own variables or name
 * share its first word (`OPENAI_BASE_URL` → OpenAI via `OPENAI_API_KEY`; `GROQ_BASE_URL` → Groq).
 */
export function overrideOwner(envVar: string, provider: { name: string; detection: { envVars: string[] } }) {
  const word = envVar.split("_")[0] ?? "";
  if (word.length < 3) return false;
  const words = new Set([
    ...provider.detection.envVars.map((v) => v.split("_")[0] ?? ""),
    ...provider.name.toUpperCase().split(/[^A-Z0-9]+/),
  ]);
  return words.has(word);
}

export function applyBaseUrlOverrides(
  findings: FindingDraft[],
  records: ChangeV2[],
  providers: { slug: string; name: string; detection: { envVars: string[] } }[],
  overrides: { file: string; line: number; envVar: string }[],
): FindingDraft[] {
  if (!overrides.length) return findings;
  return findings.map((f) => {
    if (
      f.verdict !== "affected" ||
      (f.changeKind !== "model-retirement" && f.changeKind !== "model-rerouted")
    )
      return f;
    const slug = records.find((r) => r.id === f.changeId)?.subject.provider;
    const provider = providers.find((p) => p.slug === slug);
    const set = provider ? overrides.filter((o) => overrideOwner(o.envVar, provider)) : [];
    if (!set.length) return f;
    return {
      ...f,
      verdict: "inconclusive" as const,
      reachability: "reachability-unknown" as const,
      priority: null,
      reason: `${f.reason} The client's base URL comes from ${set.map((o) => `${o.envVar} (${o.file}:${o.line})`).join(", ")}, so the deployment decides which service answers this model: check by hand.`,
    };
  });
}
