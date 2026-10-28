import { describe, expect, it } from "vitest";
import { proofOfRun, type RunForProof } from "../lib/proof";

const run = (over: Partial<RunForProof>): RunForProof => ({
  kind: "fix",
  status: "succeeded",
  step: "done",
  evidenceKind: "verified",
  prMode: "ready",
  sites: 3,
  artifact: { kind: "pr", url: "https://github.com/o/r/pull/6", number: 6 },
  ...over,
});
const states = (r: RunForProof) => Object.values(proofOfRun(r)).map((s) => s.state);

// The chain must keep "the agent finished" and "the fix was proven" apart on every surface.
describe("proofOfRun", () => {
  it("a verified PR proves every step", () => {
    expect(states(run({}))).toEqual(["done", "done", "done", "done", "done"]);
    expect(proofOfRun(run({})).pr.detail).toBe("#6");
  });

  it("a draft is fixed and opened but not proven, never failed", () => {
    const p = proofOfRun(run({ evidenceKind: "environment_mismatch", prMode: "draft" }));
    expect(p.proven).toEqual({ state: "not_proven", detail: "environment mismatch" });
    expect(p.pr.detail).toBe("#6 · draft");
  });

  it("a live run marks the step it is on and leaves later ones pending", () => {
    expect(states(run({ status: "running", step: "baseline", evidenceKind: null, artifact: null }))).toEqual([
      "done",
      "done",
      "done",
      "live",
      "pending",
    ]);
  });

  it("a dry run has no PR; a plain bump has no located use; an issue is not a PR", () => {
    expect(proofOfRun(run({ kind: "dry_run", artifact: null })).pr.state).toBe("not_applicable");
    expect(proofOfRun(run({ sites: null })).reaches.state).toBe("not_applicable");
    expect(
      proofOfRun(run({ evidenceKind: "regression", artifact: { kind: "issue", url: null, number: 9 } })),
    ).toMatchObject({
      proven: { state: "failed" },
      pr: { state: "not_applicable", detail: "issue #9 for a person" },
    });
  });

  it("a run stopped before any evidence shows where it stopped", () => {
    const p = proofOfRun(run({ status: "failed", step: "fix", evidenceKind: null, artifact: null }));
    expect([p.fixed.state, p.proven.state, p.pr.state]).toEqual([
      "failed",
      "not_applicable",
      "not_applicable",
    ]);
  });

  it("a queued run has nothing live; an issue is not a fix; a cancelled run proves nothing (round 2)", () => {
    expect(
      states(run({ status: "queued", step: null, evidenceKind: null, artifact: null, prMode: null })),
    ).toEqual(["done", "pending", "pending", "pending", "pending"]);
    const issue = proofOfRun(
      run({
        status: "failed",
        evidenceKind: "regression",
        prMode: "issue",
        artifact: { kind: "issue", url: null, number: 9 },
      }),
    );
    expect([issue.fixed.state, issue.proven.state]).toEqual(["failed", "failed"]);
    expect(
      states(
        run({ status: "cancelled", step: "fixes off", evidenceKind: null, artifact: null, prMode: null }),
      ).slice(2),
    ).toEqual(["not_applicable", "not_applicable", "not_applicable"]);
  });
});
