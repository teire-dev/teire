import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { cancelSignal } from "../cancel";
import type { PageReader } from "../catalog/adapters/vendor-page";
import { sha256 } from "../catalog/source";
import { DISCOVERY } from "../constants";
import type { CallSite, ChangeV2 } from "../contract";
import type { RepoTree } from "../inventory/tree";
import { nemotronOptions, nemotronSampling, receiptFor } from "../llm";
import { type FindingDraft, priorityOf } from "./index";

/**
 * Triage of ambiguous model-ID sites (card C3 step 5): a retired model ID the syntax cannot place,
 * because it sits in a registry or wrapper (`quick: { id: "llama-3.1-8b-instant" }`) rather than in
 * a `model:` argument. Nemotron 3 Ultra reads the file and the files that import it and says, per
 * site, whether the value reaches a request's model. Code checks the answer: the cited line must
 * exist in a file it was shown and must pass something to a model parameter. A "yes" that passes
 * makes the site decisive (resolution "traced"); anything else leaves it inconclusive for a human.
 */
export interface TriageReceipt {
  step: "triage";
  model: string;
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  costUsd: number;
  ms: number;
  cached: boolean;
}

const answerSchema = z.object({
  sites: z.array(
    z.object({
      file: z.string(),
      line: z.number().int(),
      used: z.enum(["yes", "no", "unclear"]),
      evidenceFile: z
        .string()
        .nullable()
        .describe("File where the value reaches the request's model parameter"),
      evidenceLine: z.number().int().nullable().describe("That line's number"),
      reason: z.string().describe("One sentence"),
    }),
  ),
});

const SYSTEM = `You trace string literals across the files of a code base. For each listed site, decide whether that string ends up as the model of a request this code sends to the named API provider.
Follow the value wherever it goes: a constant, an object field, a map entry or a config value that another file reads (\`TIERS[tier].id\`, \`settings.model\`) and passes as the request's model counts as used. Read every file shown, not only the file holding the literal; the files that import it are listed.
Answer per site:
- used: "yes" when you can point to the line, in any file shown, where the value reaches the request's model parameter; "no" when the code shows it is something else (a label, a log line, a comparison, a test's expected value); "unclear" when the code shown does not decide it.
- evidenceFile and evidenceLine: the file and line number where the value is passed as the model (for "yes"), else null.
- reason: one sentence.
Line numbers are printed at the start of each line.`;

const MODEL_PARAM = /\bmodel\w*\b|\bModel\b/;
/** Tests and fixtures name retired models on purpose (stand-ins, expectations): never a fix site. */
const TEST_FILE =
  /(?:^|\/)(?:tests?|__tests__|spec|fixtures?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$/;

/** Files that import `file` by module path (JS/TS relative imports, Python dotted imports). */
function importers(tree: RepoTree, repoDir: string, file: string) {
  const stem = basename(file, extname(file));
  const dotted = file.replace(extname(file), "").split("/").join(".");
  const out: string[] = [];
  for (const other of tree.files()) {
    if (other === file || !/\.(?:[cm]?[jt]sx?|py)$/.test(other) || /node_modules|\.venv|dist\//.test(other))
      continue;
    let text: string;
    try {
      text = readFileSync(join(repoDir, other), "utf8");
    } catch {
      continue;
    }
    const js = new RegExp(`(?:from|require\\(|import\\()\\s*["'][^"']*\\b${stem}(?:\\.[cm]?[jt]sx?)?["']`);
    const py = new RegExp(
      `(?:from\\s+[\\w.]*\\b${stem}\\s+import|import\\s+${dotted.replace(/\./g, "\\.")}\\b|from\\s+\\.+${stem}\\s+import)`,
    );
    if (
      js.test(text) ||
      py.test(text) ||
      (dirname(other) === dirname(file) && text.includes(`${stem}.`) && /\.py$/.test(other))
    )
      out.push(other);
  }
  return out;
}

function numbered(text: string) {
  return text
    .split("\n")
    .map((line, i) => `${i + 1}| ${line}`)
    .join("\n");
}

export async function triageModelSites(input: {
  repoDir: string;
  tree: RepoTree;
  findings: FindingDraft[];
  records: ChangeV2[];
  /** Provider slug → display name and how the repo reaches it (`npm:groq-sdk`). */
  providers: Map<string, { name: string; via: string[] }>;
  reader: PageReader;
  now?: Date;
}): Promise<{ findings: FindingDraft[]; receipts: TriageReceipt[] }> {
  const now = input.now ?? new Date();
  const receipts: TriageReceipt[] = [];
  const open = input.findings.filter(
    (f) =>
      f.verdict === "inconclusive" &&
      (f.changeKind === "model-retirement" || f.changeKind === "model-rerouted"),
  );
  if (!open.length) return { findings: input.findings, receipts };
  const record = (id: string) => input.records.find((r) => r.id === id);

  // One question per provider: its ambiguous sites, the files holding them and their importers.
  const byProvider = new Map<string, FindingDraft[]>();
  for (const f of open) {
    const slug = record(f.changeId)?.subject.provider ?? "";
    byProvider.set(slug, [...(byProvider.get(slug) ?? []), f]);
  }
  const traced = new Map<string, { evidence: string; reason: string }>();
  let budget = DISCOVERY.maxTriageSites;
  for (const [slug, findings] of byProvider) {
    const sites = findings
      .flatMap((f) => f.callSites.filter((s) => !TEST_FILE.test(s.file)).map((s) => ({ f, s })))
      .slice(0, budget);
    budget -= sites.length;
    if (!sites.length) break;
    const files = [...new Set(sites.map((x) => x.s.file))];
    const shown = [...new Set([...files, ...files.flatMap((f) => importers(input.tree, input.repoDir, f))])];
    const texts = new Map<string, string>();
    let chars = 0;
    for (const file of shown) {
      let text: string;
      try {
        text = readFileSync(join(input.repoDir, file), "utf8");
      } catch {
        continue;
      }
      if (chars + text.length > DISCOVERY.triageMaxChars) continue;
      chars += text.length;
      texts.set(file, text);
    }
    const provider = input.providers.get(slug);
    const imports = files
      .map((f) => {
        const by = importers(input.tree, input.repoDir, f).filter((x) => texts.has(x));
        return by.length ? `${f} is imported by ${by.join(", ")}.` : "";
      })
      .filter(Boolean);
    const prompt = [
      ...[...texts].map(([file, text]) => `<file path="${file}">\n${numbered(text)}\n</file>`),
      ...imports,
      `Provider: ${provider?.name ?? slug}${provider?.via.length ? ` (the repo reaches it through ${provider.via.join(", ")})` : ""}.`,
      `Sites to decide:\n${sites.map(({ f, s }) => `- ${s.file}:${s.line} the string "${f.position.version}"`).join("\n")}`,
    ].join("\n\n");
    const model = input.reader.tf.modelId("reader");
    const promptHash = sha256(`${SYSTEM}\n${prompt}`);
    const started = Date.now();
    const compute = async () => {
      try {
        const result = await generateText({
          model: input.reader.tf.model("reader"),
          abortSignal: cancelSignal(),
          system: SYSTEM,
          prompt,
          output: Output.object({ schema: answerSchema }),
          maxOutputTokens: 12_000,
          ...nemotronSampling,
          // Tracing a value through files is reasoning work; the prompts are small.
          providerOptions: nemotronOptions({ thinking: true }),
        });
        const receipt = receiptFor(result.usage, input.reader.prices?.get(model));
        return { value: { sites: result.output.sites, receipt }, costUsd: receipt.costUsd };
      } catch (error) {
        if (!NoObjectGeneratedError.isInstance(error)) throw error;
        const receipt = receiptFor(
          error.usage ?? ({} as Parameters<typeof receiptFor>[0]),
          input.reader.prices?.get(model),
        );
        return { value: { sites: [], receipt }, costUsd: receipt.costUsd };
      }
    };
    const { value, cached } = input.reader.cached
      ? await input.reader.cached(model, promptHash, compute)
      : { value: (await compute()).value, cached: false };
    receipts.push({ step: "triage", model, ...value.receipt, ms: Date.now() - started, cached });
    for (const a of value.sites) {
      if (a.used !== "yes" || !a.evidenceFile || !a.evidenceLine) continue;
      if (!sites.some(({ s }) => s.file === a.file && s.line === a.line)) continue;
      const evidence = texts.get(a.evidenceFile)?.split("\n")[a.evidenceLine - 1];
      // The cited line must exist and hand something to a model parameter.
      if (!evidence || !MODEL_PARAM.test(evidence)) continue;
      traced.set(`${a.file}:${a.line}`, {
        evidence: `${a.evidenceFile}:${a.evidenceLine} \`${evidence.trim().slice(0, 120)}\``,
        reason: a.reason,
      });
    }
  }

  const findings = input.findings.map((f) => {
    if (!open.includes(f)) return f;
    const decided = f.callSites.filter((s) => traced.has(`${s.file}:${s.line}`));
    const r = record(f.changeId);
    if (!decided.length || !r) return f;
    const sites: CallSite[] = decided.map((s) => ({ ...s, resolution: "traced" }));
    const how = decided.map((s) => traced.get(`${s.file}:${s.line}`)).filter(Boolean);
    return {
      ...f,
      verdict: "affected" as const,
      reachability: "function-reachable" as const,
      priority: priorityOf(r, "affected", now),
      callSites: sites,
      reason: `${f.reason.replace(/ \d+ mention\(s\), none passed as a model: check by hand\.$/, "")} Traced by Nemotron to the request's model: ${how.map((h) => `${h?.evidence} (${h?.reason})`).join("; ")}.`,
    };
  });
  return { findings, receipts };
}
