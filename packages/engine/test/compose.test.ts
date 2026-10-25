import { describe, expect, it } from "vitest";
import { displayQuote, joinBlocks } from "../src/github/compose";

describe("pull request markdown", () => {
  it("keeps table rows on consecutive lines so GitHub renders the table", () => {
    const body = joinBlocks([
      "### Changes",
      "| File | Change |",
      "|---|---|",
      "| `a.ts` | swap |",
      "Next paragraph",
    ]);
    expect(body).toBe("### Changes\n\n| File | Change |\n|---|---|\n| `a.ts` | swap |\n\nNext paragraph");
  });

  it("shows a quoted table row as text", () => {
    expect(
      displayQuote("| October 23, 2026 | `gpt-4.1-nano` \\| `gpt-4.1-nano-2025-04-14` | `gpt-5.6-luna` |"),
    ).toBe("October 23, 2026 · gpt-4.1-nano / gpt-4.1-nano-2025-04-14 · gpt-5.6-luna");
    expect(displayQuote("Both systems will be decommissioned.")).toBe("Both systems will be decommissioned.");
  });
});
