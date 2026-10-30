/**
 * Snapshot the landing's hero run (plan revision 3.4, C3–C4): a finished, verified run is immutable,
 * so the landing renders from a committed projection of its public sheet and its PR, with no database
 * read and nothing session-derived. Every figure is computed from the run's own data here, never typed.
 *
 *   pnpm --filter @teire/web hero-run
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://teire.vercel.app";
const HERO = "d1b0c4d8-a46e-4e9d-b057-30b6d12be23b";
/** The other real PRs that hang off the PR station (model retirement, a Nemotron major, advisories). */
const MORE = [
  { repo: "teire-dev/nlsh", number: 6 },
  { repo: "teire-dev/examples", number: 16 },
  { repo: "teire-dev/serve-handler", number: 16 },
];

interface Sheet {
  run: {
    id: string;
    kind: string;
    status: string;
    groupKey: string | null;
    fromVersion: string | null;
    targetVersion: string | null;
    evidenceKind: string | null;
    prMode: string | null;
    backend: string | null;
    diff: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  };
  repo: { fullName: string; isPrivate: boolean };
  artifact: { kind: string; number: number | null; url: string | null; state: string } | null;
  verification: {
    baseline?: {
      name: string;
      exitCode: number | null;
      counts: { passed: number; collected: number } | null;
    }[];
    after?: { name: string; exitCode: number | null; counts: { passed: number; collected: number } | null }[];
  } | null;
  events: { seq: number; at: string; step: string; type: string; payload: unknown }[];
  calls: { purpose: string; model: string; costUsd: string }[];
  reach: { sites: number | null; advisory: boolean };
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "teire-hero-snapshot" },
  });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

const pr = (repo: string, n: number) =>
  json<{
    title: string;
    html_url: string;
    state: string;
    draft: boolean;
    body: string | null;
    user: { login: string };
  }>(`https://api.github.com/repos/${repo}/pulls/${n}`);

const sheet = await json<Sheet>(`${ORIGIN}/api/runs/${HERO}/sheet?after=0`);
if (sheet.repo.isPrivate) throw new Error("the hero run must be on a public repository");
if (sheet.run.evidenceKind !== "verified" || sheet.artifact?.kind !== "pr")
  throw new Error("the hero run must be verified with a PR");

const heroPr = await pr(sheet.repo.fullName, sheet.artifact.number as number);
const advisory = heroPr.body?.match(
  /\[(GHSA-[\w-]+)\]\([^)]*\)[^\n]*\((critical|high|moderate|medium|low)\)/i,
);

// The first checks after the upgrade, before the agent touched the code: "after: typecheck exit 2 in
// 3715 ms (4 TS errors)", "after: test exit 1 in 1910 ms (1/4 passed)".
const firstAgent = sheet.events.find((e) => e.step === "agent")?.seq ?? Number.POSITIVE_INFINITY;
const broke: Record<string, { exit: number; said: string | null }> = {};
for (const e of sheet.events) {
  if (e.seq > firstAgent || e.step !== "check") continue;
  const said = (e.payload as { detail?: string } | null)?.detail ?? "";
  const m = /^after: (\w+) exit (\d+) in \d+ ms(?: \((.+)\))?/.exec(said);
  if (m?.[1] && m[2] !== "0" && !broke[m[1]]) broke[m[1]] = { exit: Number(m[2]), said: m[3] ?? null };
}
if (!broke.typecheck && !broke.test) throw new Error("the hero run must show what the upgrade broke");

// The updater: from its first event to the first install/baseline event after it.
const at = (step: string) => sheet.events.find((e) => e.step === step)?.at;
const resolverStart = at("resolver");
const afterResolver = sheet.events.find(
  (e) => resolverStart && e.at > resolverStart && (e.step === "baseline" || e.step === "install"),
)?.at;
const updaterSeconds =
  resolverStart && afterResolver
    ? Math.round((Date.parse(afterResolver) - Date.parse(resolverStart)) / 1000)
    : null;

// Every Nemotron call of the run (reading the notes, fixing, reviewing), as the receipt counts them.
const nemotron = sheet.calls.filter((c) => /nemotron/i.test(c.model));
const fixCalls = sheet.calls.filter((c) => c.purpose === "fix");
const cost = sheet.calls.reduce((s, c) => s + Number(c.costUsd || 0), 0);

// The diff: files, additions, deletions, and the first hunk of the first source file as a peek.
const diff = sheet.run.diff ?? "";
// Teire's diffs are unified diffs with "--- a/<file>" headers (no "diff --git" lines).
const files = [...diff.matchAll(/^--- a\/(\S+)/gm)].map((m) => m[1] as string);
const isManifest = (f: string) => /(^|\/)(package(-lock)?\.json|[^/]*\.lock|[^/]*lock\.(json|yaml))$/.test(f);
// Lines changed in the code Nemotron adapted (the manifest and the lockfile are the updater's).
let srcAdded = 0;
let srcRemoved = 0;
for (const section of diff.split(/^=+$/m)) {
  const f = /^--- a\/(\S+)/m.exec(section)?.[1];
  if (!f || isManifest(f)) continue;
  srcAdded += (section.match(/^\+(?!\+\+ )/gm) ?? []).length;
  srcRemoved += (section.match(/^-(?!-- )/gm) ?? []).length;
}
const added = (diff.match(/^\+(?!\+\+ )/gm) ?? []).length;
const removed = (diff.match(/^-(?!-- )/gm) ?? []).length;
const sourceFile = files.find((f) => !/package(-lock)?\.json|lock|\.lock$/.test(f)) ?? files[0];
let peek: { file: string; lines: { kind: "add" | "del" | "ctx"; text: string }[] } | null = null;
if (sourceFile) {
  const section = diff.split(/^=+$/m).find((s) => s.includes(`--- a/${sourceFile}`)) ?? "";
  const hunk = section.split(/^@@[^\n]*\n/m)[1] ?? "";
  const lines = hunk
    .split("\n")
    .filter((l) => l.length > 0)
    .filter((l) => l.startsWith("+") || l.startsWith("-") || l.startsWith(" "))
    .slice(0, 8)
    .map((l) => ({
      kind: (l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx") as "add" | "del" | "ctx",
      text: l.slice(1),
    }));
  peek = { file: sourceFile, lines };
}

const check = (side: "baseline" | "after", name: string) =>
  sheet.verification?.[side]?.find((c) => c.name === name);
const tests = (side: "baseline" | "after") => {
  const c = check(side, "test")?.counts;
  return c ? `${c.passed}/${c.collected}` : null;
};

// The run's steps in order, consecutive repeats folded: the scroll timeline's captions.
const steps: { step: string; at: string }[] = [];
for (const e of sheet.events) if (steps.at(-1)?.step !== e.step) steps.push({ step: e.step, at: e.at });

const more = [];
for (const m of MORE) {
  const p = await pr(m.repo, m.number);
  const run = p.body?.match(/run=([0-9a-f-]{36})/)?.[1] ?? null;
  const ms = run ? await json<Sheet>(`${ORIGIN}/api/runs/${run}/sheet?after=0`).catch(() => null) : null;
  more.push({
    groupKey: ms?.run.groupKey ?? null,
    from: ms?.run.fromVersion ?? null,
    to: ms?.run.targetVersion ?? null,
    evidence: ms?.run.evidenceKind ?? null,
    mode: ms?.run.prMode ?? null,
    repo: m.repo,
    number: m.number,
    title: p.title,
    url: p.html_url,
    state: p.state,
    draft: p.draft,
    verified: /^\*\*Verified\.\*\*/m.test(p.body ?? ""),
    run,
  });
}

const snapshot = {
  takenAt: new Date().toISOString(),
  run: {
    id: sheet.run.id,
    href: `/runs/${sheet.run.id}`,
    groupKey: sheet.run.groupKey,
    package: (sheet.run.groupKey ?? "").split("/")[1] ?? "",
    ecosystem: (sheet.run.groupKey ?? "").split("/")[0] ?? "",
    from: sheet.run.fromVersion,
    to: sheet.run.targetVersion,
    backend: sheet.run.backend,
    finishedAt: sheet.run.finishedAt,
  },
  repo: sheet.repo.fullName,
  advisory: advisory ? { id: advisory[1], severity: (advisory[2] as string).toLowerCase() } : null,
  reach: sheet.reach,
  updaterSeconds,
  fix: {
    calls: nemotron.length,
    fixCalls: fixCalls.length,
    model: fixCalls[0]?.model ?? null,
    costUsd: Number(cost.toFixed(3)),
  },
  diff: {
    files: files.length,
    // The code Nemotron adapted, apart from the manifest and the lockfile the updater changed.
    sourceFiles: files.filter((f) => !isManifest(f)).length,
    added,
    removed,
    srcAdded,
    srcRemoved,
    peek,
  },
  // What the upgrade broke before the fix (the hero card's red column): the first failing "after:"
  // check lines, logged before the agent's first step.
  broke,
  checks: {
    tests: { before: tests("baseline"), after: tests("after") },
    typecheck: {
      before: check("baseline", "typecheck")?.exitCode === 0,
      after: check("after", "typecheck")?.exitCode === 0,
    },
  },
  pr: {
    number: sheet.artifact.number,
    url: sheet.artifact.url,
    title: heroPr.title,
    state: heroPr.state,
    draft: heroPr.draft,
    mode: sheet.run.prMode,
    verified: sheet.run.evidenceKind === "verified",
  },
  steps,
  more,
};

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "landing", "hero-run.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log("wrote", path.relative(process.cwd(), out), {
  advisory: snapshot.advisory,
  updaterSeconds,
  fix: snapshot.fix,
  diff: { files: files.length, added, removed, peek: peek?.file },
  checks: snapshot.checks,
});
