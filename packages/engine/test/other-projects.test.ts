import { describe, expect, it } from "vitest";
import { type FixRun, unchecked, withWeakest } from "../src/fix/run";
import { projectOf } from "../src/verify/projects";

// Every project a change touches is verified, and one that can't be is never dropped (review R2).
const verifiedRun = {
  evidence: {
    kind: "verified",
    prMode: "ready",
    reasons: ["70/70 tests passed"],
    baseline: null,
    after: null,
    classified: null,
  },
} as unknown as FixRun;

describe("other projects", () => {
  it("an unchecked project makes a verified run unverified, naming the project", () => {
    const run = withWeakest(verifiedRun, [
      unchecked("go-openai", "go", "couldn't be checked (sandbox did not open)"),
    ]);
    expect(run.evidence.kind).toBe("unverified");
    expect(run.evidence.prMode).not.toBe("ready");
    expect(run.evidence.reasons[0]).toBe("in `go-openai`: couldn't be checked (sandbox did not open)");
    expect(run.others).toHaveLength(1);
  });

  it("a passing other project keeps the lead's evidence", () => {
    const fine = { ...unchecked("ai-web", "npm", ""), evidence: verifiedRun.evidence };
    expect(withWeakest(verifiedRun, [fine]).evidence.kind).toBe("verified");
  });

  it("a file belongs to the project of its own ecosystem when roots coincide", () => {
    const projects = [
      { root: ".", ecosystem: "npm" },
      { root: ".", ecosystem: "pypi" },
      { root: "svc", ecosystem: "go" },
    ];
    expect(projectOf(projects, "app/llm.py")?.ecosystem).toBe("pypi");
    expect(projectOf(projects, "src/index.ts")?.ecosystem).toBe("npm");
    expect(projectOf(projects, "svc/main.go")?.root).toBe("svc");
    expect(projectOf(projects, "README.md")?.root).toBe(".");
  });
});
