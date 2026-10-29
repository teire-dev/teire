import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { reviewBump } from "../src/fix/review";
import type { TokenFactory } from "../src/llm";

const usage = {
  inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 60, text: 60, reasoning: 0 },
};

function tokenFactory(answer: unknown, prompts: string[]) {
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text", text: JSON.stringify(answer) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });
  return {
    model: () => model,
    modelId: () => "nvidia/Nemotron-3-Ultra-550b-a55b",
  } as unknown as TokenFactory;
}

describe("the short review on a run with no code edits (S15.5)", () => {
  it("reads what moved, the quoted notes and the checks, and lists concerns against the manifest", async () => {
    const prompts: string[] = [];
    const tf = tokenFactory(
      {
        concerns: [
          { source: "note: requests 3.0", concern: "The default timeout changed from none to 30 seconds." },
        ],
      },
      prompts,
    );
    const review = await reviewBump({
      tf,
      brief: "Upgrade requests 2.32.3 → 3.0.0",
      notes: [
        {
          summary: "Timeouts default to 30 s",
          apis: [],
          replacement: null,
          quote: "requests now applies a 30 second default timeout",
          url: "https://example.org/notes",
        },
      ],
      moved: "requirements.txt: 2.32.3 → 3.0.0\nmoved with it: urllib3 1.26.20 → 2.2.3",
      checks: "verified: test passes on the baseline and after; 12/12 tests passed",
      file: "requirements.txt",
    });
    expect(review.scope).toBe("change");
    expect(review.problems).toEqual([
      {
        file: "requirements.txt",
        problem: "The default timeout changed from none to 30 seconds. (note: requests 3.0)",
      },
    ]);
    expect(prompts[0]).toContain("urllib3 1.26.20 → 2.2.3");
    expect(prompts[0]).toContain("requests now applies a 30 second default timeout");
    expect(prompts[0]).toContain("12/12 tests passed");
  });

  it("says when no notes were found, and returns no concerns when there are none", async () => {
    const prompts: string[] = [];
    const review = await reviewBump({
      tf: tokenFactory({ concerns: [] }, prompts),
      brief: "Upgrade itoa 1.0.10 → 1.0.14",
      notes: [],
      moved: "Cargo.lock: +2/−2 lines",
      checks: "verified: build, test pass on the baseline and after",
      file: "Cargo.toml",
    });
    expect(review.problems).toEqual([]);
    expect(prompts[0]).toContain("No migration notes were found");
  });
});
