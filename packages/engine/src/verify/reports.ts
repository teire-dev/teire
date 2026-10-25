import type { TestCounts } from "../contract";

/**
 * Test counts for the test-count gate (rule 13): from the runner's JSON report when Teire could ask
 * for one (vitest and jest share the format), otherwise from the summary line every common runner
 * prints. Null when nothing could be read: then the gate cannot apply and the run is not "verified".
 */
interface JestLikeReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  numRuntimeErrorTestSuites?: number;
  numFailedTestSuites?: number;
  testResults?: { status?: string; message?: string }[];
}

export function countsFromJson(text: string): TestCounts | null {
  let report: JestLikeReport;
  try {
    report = JSON.parse(text) as JestLikeReport;
  } catch {
    return null;
  }
  if (typeof report.numTotalTests !== "number") return null;
  const suiteErrors =
    report.numRuntimeErrorTestSuites ??
    (report.testResults ?? []).filter((r) => r.status === "failed" && r.message && !/✓|✕|×/.test(r.message))
      .length;
  return {
    collected: report.numTotalTests,
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
    errors: suiteErrors,
  };
}

/** pytest `--junitxml`: sums the `<testsuite>` counters (a collection error counts as an error). */
export function countsFromJunit(xml: string): TestCounts | null {
  const suites = [...xml.matchAll(/<testsuite\b([^>]*)>/g)].map((m) => m[1] ?? "");
  if (!suites.length) return null;
  const attr = (s: string, name: string) => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(s)?.[1] ?? 0);
  const sum = (name: string) => suites.reduce((n, s) => n + attr(s, name), 0);
  const collected = sum("tests");
  const failed = sum("failures");
  const errors = sum("errors");
  const skipped = sum("skipped");
  return { collected, passed: Math.max(0, collected - failed - errors - skipped), failed, skipped, errors };
}

/** Terminal colour codes (ESC [ … m), built from the code point so the source has no control character. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * `go test -json` events (one JSON object per line): a test's final action is pass, fail or skip;
 * a package that fails with no test (a build failure) counts as an error.
 */
export function countsFromGoJson(output: string): TestCounts | null {
  const final = new Map<string, string>();
  const packages = new Map<string, { failed: boolean; tests: number }>();
  let events = 0;
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: { Action?: string; Package?: string; Test?: string };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.Action) continue;
    events++;
    const pkg = packages.get(e.Package ?? "") ?? { failed: false, tests: 0 };
    if (e.Test && ["pass", "fail", "skip"].includes(e.Action)) {
      if (!final.has(`${e.Package}\u0000${e.Test}`)) pkg.tests++;
      final.set(`${e.Package}\u0000${e.Test}`, e.Action);
    } else if (!e.Test && e.Action === "fail") pkg.failed = true;
    packages.set(e.Package ?? "", pkg);
  }
  if (!events) return null;
  const actions = [...final.values()];
  const count = (a: string) => actions.filter((x) => x === a).length;
  const errors = [...packages.values()].filter((p) => p.failed && p.tests === 0).length;
  return {
    collected: actions.length,
    passed: count("pass"),
    failed: count("fail"),
    skipped: count("skip"),
    errors,
  };
}

/** `go test -json` back to the plain text a person (or the fix agent) reads: the events' Output lines. */
export function goJsonToText(output: string) {
  if (!/^\{"Time":"[^"]+","Action":/m.test(output)) return output;
  const out: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) {
      if (line.trim()) out.push(line);
      continue;
    }
    try {
      const e = JSON.parse(line) as { Output?: string };
      if (e.Output) out.push(e.Output.replace(/\n$/, ""));
    } catch {
      out.push(line);
    }
  }
  return out.join("\n");
}

export function countsFromOutput(output: string): TestCounts | null {
  if (/^\{"Time":"[^"]+","Action":/m.test(output)) return countsFromGoJson(output);
  const text = output.replace(ANSI, "");
  // vitest: "Tests  2 passed | 1 failed | 1 skipped (4)"
  const vitest = /^\s*Tests\s+(.+?)\s+\((\d+)\)\s*$/m.exec(text);
  if (vitest?.[1] && vitest[2]) {
    const part = (word: string) => Number(new RegExp(`(\\d+)\\s+${word}`).exec(vitest[1] ?? "")?.[1] ?? 0);
    const errors = Number(/Errors\s+(\d+)\s+error/.exec(text)?.[1] ?? 0);
    return {
      collected: Number(vitest[2]),
      passed: part("passed"),
      failed: part("failed"),
      skipped: part("skipped") + part("todo"),
      errors,
    };
  }
  // jest: "Tests:       1 failed, 2 passed, 3 total"
  const jest = /^Tests:\s+(.+?)(\d+) total\s*$/m.exec(text);
  if (jest?.[2]) {
    const part = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(jest[1] ?? "")?.[1] ?? 0);
    // A suite that fails to load fails no test; count it as an error so the gate sees it.
    const failedSuites = Number(/Test Suites:.*?(\d+) failed/.exec(text)?.[1] ?? 0);
    return {
      collected: Number(jest[2]),
      passed: part("passed"),
      failed: part("failed"),
      skipped: part("skipped") + part("todo"),
      errors: part("failed") === 0 ? failedSuites : 0,
    };
  }
  // pytest: "===== 2 passed, 1 failed, 1 skipped in 0.12s =====" (or "1 error in …" on a collection error)
  const pytest = /^=+ (.*?) in [\d.]+s/m.exec(text);
  if (pytest?.[1] && /\b(passed|failed|error|errors|skipped)\b/.test(pytest[1])) {
    const part = (word: string) => Number(new RegExp(`(\\d+) ${word}\\b`).exec(pytest[1] ?? "")?.[1] ?? 0);
    const passed = part("passed");
    const failed = part("failed");
    const skipped = part("skipped") + part("xfailed");
    const errors = part("errors") + part("error");
    return { collected: passed + failed + skipped + errors, passed, failed, skipped, errors };
  }
  // node:test (TAP): "# tests 3", "# pass 3", "# fail 0", "# skipped 0"
  const tap = /^# tests (\d+)/m.exec(text);
  if (tap?.[1]) {
    const n = (k: string) => Number(new RegExp(`^# ${k} (\\d+)`, "m").exec(text)?.[1] ?? 0);
    return {
      collected: Number(tap[1]),
      passed: n("pass"),
      failed: n("fail"),
      skipped: n("skipped") + n("todo"),
      errors: 0,
    };
  }
  // mocha: "3 passing", "1 failing", "2 pending"
  const passing = /^\s*(\d+) passing/m.exec(text);
  if (passing?.[1]) {
    const failing = Number(/^\s*(\d+) failing/m.exec(text)?.[1] ?? 0);
    const pending = Number(/^\s*(\d+) pending/m.exec(text)?.[1] ?? 0);
    return {
      collected: Number(passing[1]) + failing + pending,
      passed: Number(passing[1]),
      failed: failing,
      skipped: pending,
      errors: 0,
    };
  }
  return null;
}

/** TypeScript errors in compiler output (`error TS2339`). */
export function typeErrorCount(output: string) {
  return (output.replace(ANSI, "").match(/error TS\d+/g) ?? []).length;
}
