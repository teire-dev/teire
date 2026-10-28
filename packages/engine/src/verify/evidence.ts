import { type EvidenceKind, PR_MODE_BY_EVIDENCE } from "../constants";
import type { TestCounts } from "../contract";
import { type Classified, classifyFailure } from "./classify";

/**
 * Evidence decides the PR (rule 13, D48): baseline and after ran the same offline checks, each on
 * its own install (D69). A ready PR needs `verified`: every check the baseline passed still
 * passes, tests ran and were counted, and the count did not shrink (test-count gate).
 */
export type CheckName = "typecheck" | "build" | "test";

export interface CheckResult {
  name: CheckName;
  argv: string[];
  exitCode: number;
  ms: number;
  timedOut: boolean;
  counts: TestCounts | null;
  typeErrors: number;
  /** Last part of the combined output, for the PR body and the classifier. */
  output: string;
}

export interface SideResult {
  side: "baseline" | "after";
  install: { ok: boolean; exitCode: number; ms: number; output: string };
  checks: CheckResult[];
  /** Hosts the check phase tried to reach and was refused. */
  deniedHosts: string[];
}

export interface Evidence {
  kind: EvidenceKind;
  prMode: (typeof PR_MODE_BY_EVIDENCE)[EvidenceKind];
  reasons: string[];
  baseline: TestCounts | null;
  after: TestCounts | null;
  classified: Classified | null;
}

const passed = (c: CheckResult | undefined) => !!c && c.exitCode === 0 && !c.timedOut;

function testOutcome(c: CheckResult | undefined) {
  if (!c) return null;
  return c.counts;
}

export function decideEvidence(baseline: SideResult, after: SideResult): Evidence {
  const reasons: string[] = [];
  const done = (kind: EvidenceKind, classified: Classified | null = null): Evidence => ({
    kind,
    prMode: PR_MODE_BY_EVIDENCE[kind],
    reasons,
    baseline: testOutcome(baseline.checks.find((c) => c.name === "test")),
    after: testOutcome(after.checks.find((c) => c.name === "test")),
    classified,
  });

  if ([...baseline.checks, ...after.checks].some((c) => c.timedOut)) {
    // On the unchanged code it is the repository's own check that is too slow, not the change.
    const slow = baseline.checks.filter((c) => c.timedOut).map((c) => c.name);
    // Only the tests are too slow, on both sides, and the typecheck passes before and after: the
    // change is judged by the typecheck, as a draft that says so (live walk, explain-error-plugin).
    const typecheck = (side: SideResult) => side.checks.find((c) => c.name === "typecheck");
    const others = (side: SideResult) => side.checks.filter((c) => c.name !== "test");
    if (
      slow.length === 1 &&
      slow[0] === "test" &&
      after.checks.find((c) => c.name === "test")?.timedOut &&
      passed(typecheck(baseline)) &&
      passed(typecheck(after)) &&
      others(baseline).every(passed) &&
      others(after).every(passed)
    ) {
      reasons.push(
        `the repository's own test ran past its time limit on the unchanged code (${Math.round((baseline.checks.find((c) => c.timedOut)?.ms ?? 0) / 60_000)} min) and after the change; the typecheck passes before and after`,
      );
      return done("typecheck_only");
    }
    reasons.push(
      slow.length
        ? `the repository's own ${slow.join(" and ")} ran past its time limit on the unchanged code (${Math.round((baseline.checks.find((c) => c.timedOut)?.ms ?? 0) / 60_000)} min), so it can't judge the change`
        : "a check hit its time limit",
    );
    return done("timeout");
  }
  if (!baseline.install.ok) {
    // An install that hit its time limit (exit 124) did not fail on the lockfile; say which it was.
    reasons.push(
      baseline.install.exitCode === 124
        ? `the repo's own install did not finish within its time limit in the sandbox (${Math.round(baseline.install.ms / 60_000)} min), so there is no baseline`
        : "the repo's own lockfile does not install in the sandbox, so there is no baseline",
    );
    return done("environment_mismatch", classifyFailure(baseline.install.output, []));
  }
  if (!after.install.ok) {
    reasons.push("the upgraded lockfile does not install");
    return done("regression");
  }
  if (after.checks.length === 0) {
    reasons.push("no typecheck, build or test command was found");
    return done("unverified");
  }

  let preExisting = false;
  const failedBoth: CheckResult[] = [];
  for (const a of after.checks) {
    const b = baseline.checks.find((c) => c.name === a.name);
    if (passed(a)) continue;
    if (!b || passed(b)) {
      reasons.push(`${a.name} passes on the baseline and fails after the change`);
      return done("regression");
    }
    // Both fail: only "no worse" keeps it a pre-existing failure.
    if (a.name === "test" && a.counts && b.counts) {
      if (
        a.counts.failed + a.counts.errors > b.counts.failed + b.counts.errors ||
        a.counts.passed < b.counts.passed
      ) {
        reasons.push(`more tests fail after the change (${b.counts.failed} → ${a.counts.failed})`);
        return done("regression");
      }
    } else if (a.name !== "test" && a.typeErrors > b.typeErrors) {
      reasons.push(`${a.name} errors grew after the change (${b.typeErrors} → ${a.typeErrors})`);
      return done("regression");
    }
    preExisting = true;
    failedBoth.push(a);
  }

  const testsAfter = after.checks.find((c) => c.name === "test");
  const testsBefore = baseline.checks.find((c) => c.name === "test");
  if (testsAfter?.counts && testsBefore?.counts) {
    const a = testsAfter.counts;
    const b = testsBefore.counts;
    if (a.collected < b.collected || a.skipped > b.skipped) {
      reasons.push(
        `fewer tests ran after the change (${b.collected} collected → ${a.collected}, skipped ${b.skipped} → ${a.skipped})`,
      );
      return done("regression");
    }
  }

  if (preExisting) {
    const denied = [...new Set([...baseline.deniedHosts, ...after.deniedHosts])];
    const classified = classifyFailure(failedBoth.map((c) => c.output).join("\n"), denied);
    reasons.push(
      `${failedBoth.map((c) => c.name).join(", ")} failed on the baseline too, and no worse after the change`,
    );
    if (classified.cause) {
      reasons.push(
        classified.cause === "needs_live_access"
          ? `the failing checks need the network${classified.hosts.length ? ` (${classified.hosts.join(", ")})` : ""}`
          : classified.cause === "needs_local_service"
            ? `the failing checks need ${classified.details.join(", ")}`
            : "the failing checks need a different runtime or native build",
      );
      return done(classified.cause, classified);
    }
    return done("pre_existing_failure", classified);
  }

  if (testsAfter?.counts && testsAfter.counts.collected > 0) {
    // Checks that failed before and pass after: the change had already broken the repo (a retired model).
    const fixed = baseline.checks.filter((b) => !passed(b)).map((b) => b.name);
    const kept = after.checks.map((c) => c.name).filter((n) => !fixed.includes(n));
    reasons.push(
      [
        fixed.length ? `${fixed.join(", ")} failed on the baseline and pass after the change` : "",
        kept.length ? `${kept.join(", ")} pass on the baseline and after` : "",
        `${testsAfter.counts.passed}/${testsAfter.counts.collected} tests passed`,
      ]
        .filter(Boolean)
        .join("; "),
    );
    return done("verified");
  }
  if (after.checks.some((c) => c.name === "typecheck" || c.name === "build")) {
    reasons.push(
      testsAfter ? "tests ran but none were counted" : "the repo has no test command; the typecheck passes",
    );
    return done("typecheck_only");
  }
  reasons.push("tests passed but none were counted");
  return done("unverified");
}
