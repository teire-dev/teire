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

/** Terminal colour codes (ESC [ … m), built from the code point so the source has no control character. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function countsFromOutput(output: string): TestCounts | null {
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
