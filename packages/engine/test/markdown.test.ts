import { describe, expect, it } from "vitest";
import { codeSpans, isoDate, plain, quoteAppearsIn, sections, tables } from "../src/catalog/markdown";

describe("isoDate", () => {
  it("reads the date forms providers use", () => {
    expect(isoDate("October 23, 2026")).toBe("2026-10-23");
    expect(isoDate("Aug 10, 2026")).toBe("2026-08-10");
    expect(isoDate("2026-10-21")).toBe("2026-10-21");
    // OpenAI writes some dates with non-breaking hyphens.
    expect(isoDate("2026‑05‑12")).toBe("2026-05-12");
  });
  it("returns null when there is no date", () => {
    expect(isoDate("No shutdown date announced")).toBeNull();
    expect(isoDate("N/A")).toBeNull();
    expect(isoDate("To be announced")).toBeNull();
  });
});

describe("plain", () => {
  it("keeps underscores inside identifiers and drops emphasis", () => {
    expect(plain("`nvidia/Nemotron-3_5-Lightning`")).toBe("nvidia/Nemotron-3_5-Lightning");
    expect(plain("**On August 31, 2026:**")).toBe("On August 31, 2026:");
    expect(plain("[label](https://x.y/z)")).toBe("label");
  });
});

describe("tables", () => {
  it("keeps escaped pipes inside cells", () => {
    const [table] = tables("| Date | Model |\n| --- | --- |\n| Oct 23, 2026 | `gpt-4-0613` \\| `gpt-4` |\n");
    expect(table?.rows[0]?.cells).toHaveLength(2);
    expect(codeSpans(table?.rows[0]?.cells[1] ?? "")).toEqual(["gpt-4-0613", "gpt-4"]);
  });
});

describe("sections", () => {
  it("ignores headings inside code fences", () => {
    const parts = sections("### A\ntext\n```\n### not a heading\n```\n### B\nmore\n", 3);
    expect(parts.map((p) => p.heading)).toEqual(["A", "B"]);
  });
});

describe("quoteAppearsIn", () => {
  it("matches across whitespace and escapes", () => {
    expect(quoteAppearsIn("a | b", "x a \\| b y")).toBe(true);
    expect(quoteAppearsIn("a  b", "a\n b")).toBe(true);
    expect(quoteAppearsIn("missing", "nothing here")).toBe(false);
  });
  it("matches decoded string values in JSON bodies", () => {
    const body = JSON.stringify({ versions: { "2.88.2": { deprecated: 'request has been "deprecated"' } } });
    expect(quoteAppearsIn('request has been "deprecated"', body)).toBe(true);
  });
});
