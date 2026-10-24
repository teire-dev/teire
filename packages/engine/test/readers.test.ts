import { describe, expect, it } from "vitest";
import { readAnthropic } from "../src/catalog/adapters/anthropic";
import { readDeprecationTables } from "../src/catalog/adapters/deprecation-tables";
import { breakingRows, readStripe } from "../src/catalog/adapters/stripe";
import { noticeDate } from "../src/catalog/adapters/tokenfactory";
import { changeRecord } from "../src/catalog/schema";
import { fixture, source } from "./helpers";

const valid = (records: unknown[]) => records.every((r) => changeRecord.safeParse(r).success);

describe("OpenAI deprecations (developers.openai.com/api/docs/deprecations.md)", () => {
  const records = readDeprecationTables(
    source(
      "catalog/openai-deprecations.excerpt.md",
      "https://developers.openai.com/api/docs/deprecations.md",
    ),
    { provider: "openai", sectionLevel: 3 },
  );
  it("turns each row into a valid record", () => {
    expect(records.length).toBeGreaterThan(10);
    expect(valid(records)).toBe(true);
  });
  it("keeps every alias and the replacement", () => {
    const gpt4 = records.find((r) => r.signatures.modelIds.includes("gpt-4"));
    expect(gpt4?.signatures.modelIds).toEqual([
      "gpt-4-0613",
      "gpt-4",
      "gpt-4-0613-completions",
      "gpt-4-completions",
    ]);
    expect(gpt4?.effectiveOn).toBe("2026-10-23");
    expect(gpt4?.announcedOn).toBe("2026-04-22");
    expect(gpt4?.replacement?.value).toBe("gpt-5.6-sol");
  });
  it("classifies endpoint rows", () => {
    const engines = records.find((r) => r.signatures.endpoints.includes("/v1/engines"));
    expect(engines?.kind).toBe("endpoint-removal");
  });
});

describe("Anthropic deprecations", () => {
  const records = readAnthropic(
    source(
      "catalog/anthropic-deprecations.excerpt.md",
      "https://platform.claude.com/docs/en/about-claude/model-deprecations.md",
    ),
  );
  it("reads model rows and the parameter table", () => {
    expect(valid(records)).toBe(true);
    const params = records.find((r) => r.kind === "parameter-change");
    expect(params?.signatures.params).toEqual(["temperature", "top_p", "top_k"]);
    expect(params?.signatures.apiVersions).toEqual(["2026-10-21"]);
  });
});

describe("Gemini deprecations", () => {
  const records = readDeprecationTables(
    source(
      "catalog/gemini-deprecations.excerpt.md",
      "https://ai.google.dev/gemini-api/docs/deprecations.md.txt",
    ),
    { provider: "google-gemini", sectionLevel: 2 },
  );
  it("skips models with no date and no replacement, and flags silent reroutes", () => {
    expect(valid(records)).toBe(true);
    expect(records.some((r) => r.signatures.modelIds.includes("gemini-3.8-flash"))).toBe(false);
    expect(records.find((r) => r.signatures.modelIds.includes("gemini-3.7-flash"))?.kind).toBe(
      "model-rerouted",
    );
    expect(records.find((r) => r.signatures.modelIds.includes("gemini-2.0-flash"))?.effectiveOn).toBe(
      "2026-06-01",
    );
  });
});

describe("Token Factory notices", () => {
  const src = source(
    "catalog/tokenfactory-august-2026.excerpt.md",
    "https://docs.tokenfactory.nebius.com/august-2026-deprecation-notice.md",
  );
  it("reads the date from the bold notice and every row", () => {
    const stated = noticeDate(src.body);
    expect(stated?.date).toBe("2026-08-31");
    const records = readDeprecationTables(src, {
      provider: "nebius-token-factory",
      sectionLevel: 0,
      documentDate: stated?.date ?? null,
      documentDateQuote: stated?.quote,
    });
    expect(valid(records)).toBe(true);
    const ultra = records.find((r) =>
      r.signatures.modelIds.includes("nvidia/Llama-3_1-Nemotron-Ultra-253B-v1"),
    );
    expect(ultra?.replacement?.value).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(ultra?.sources).toHaveLength(2);
  });
});

describe("Stripe changelog", () => {
  const changelog = source("catalog/stripe-changelog.excerpt.md", "https://docs.stripe.com/changelog.md");
  it("finds breaking rows, including versions without a codename", () => {
    const rows = breakingRows(changelog, {});
    expect(rows.some((r) => r.version === "2026-09-30.endive")).toBe(true);
    expect(rows.some((r) => r.version === "2024-06-20")).toBe(true);
  });
  it("reads field-level changes from a detail page", async () => {
    const detailUrl =
      "https://docs.stripe.com/changelog/endive/2026-09-30/polymorphic-billing-cycle-anchor.md";
    const body = fixture("catalog/stripe-detail-polymorphic-billing-cycle-anchor.md");
    const records = await readStripe(changelog, {
      since: "2026-09-01",
      fetchDetail: async (url) =>
        url === detailUrl
          ? {
              status: "changed",
              source: { ...source("catalog/stripe-detail-polymorphic-billing-cycle-anchor.md", url), body },
            }
          : { status: "failed", checkedAt: "2026-10-24T12:00:00.000Z", error: "not captured" },
    });
    expect(valid(records)).toBe(true);
    const anchor = records.find((r) => r.id.includes("polymorphic-billing-cycle-anchor"));
    expect(anchor?.kind).toBe("parameter-change");
    expect(anchor?.signatures.params).toContain("billing_cycle_anchor");
    expect(anchor?.signatures.packages.map((p) => p.ecosystem).sort()).toEqual(["npm", "pypi"]);
    // Pages that could not be read stay visible but quarantined.
    expect(records.filter((r) => r.status === "quarantined").length).toBe(records.length - 1);
  });
});
