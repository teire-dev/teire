import { describe, expect, it } from "vitest";
import type { ChangeV2 } from "../src/contract";
import { assessProviderChanges } from "../src/impact/provider";
import type { LiteralScan } from "../src/locate/literals";

const record = {
  schemaVersion: 2,
  id: "models/acme/acme-chat-1/retired",
  subject: { kind: "model", provider: "acme", name: "acme-chat-1" },
  kind: "model-retirement",
  title: "acme-chat-1 retires",
  summary: "acme-chat-1 retires on 2026-11-01.",
  applicability: { class: "breaks-on-date", effectiveOn: "2026-11-01", fixedIn: [] },
  replacement: { value: "acme-chat-2", modelIds: ["acme-chat-2"] },
  signatures: [{ kind: "string-literal", value: "acme-chat-1" }],
  sources: [{ url: "https://acme.example/deprecations", kind: "provider-page", trustBasis: "provider" }],
  status: "quarantined",
  quarantineReasons: ["the quote isn't on the fetched page"],
  visibility: "public",
} as unknown as ChangeV2;

const scan: LiteralScan = {
  hits: [
    {
      file: "app.py",
      line: 3,
      column: 10,
      value: "acme-chat-1",
      kind: "model",
      lang: "py",
      context: "llm-call-arg",
      snippet: 'client.chat(model="acme-chat-1")',
    },
  ],
  filesScanned: 4,
  languages: ["py"],
  ms: 1,
};

describe("a quarantined provider record (S16.3)", () => {
  it("says check by hand on a scan, with why and how to try it anyway", () => {
    const [f] = assessProviderChanges({ records: [record], scan, now: new Date("2026-10-29") });
    expect(f?.verdict).toBe("check_by_hand");
    expect(f?.priority).toBeNull();
    expect(f?.unconfirmed).toEqual(["the quote isn't on the fetched page"]);
    expect(f?.reason).toContain("`@teire fix` tries it anyway, as a draft marked unconfirmed");
  });

  it("is used when a person asks, every finding marked unconfirmed", () => {
    const [f] = assessProviderChanges({
      records: [record],
      scan,
      now: new Date("2026-10-29"),
      includeQuarantined: true,
    });
    expect(f?.verdict).toBe("affected");
    expect(f?.unconfirmed).toEqual(["the quote isn't on the fetched page"]);
  });

  it("stays silent on a mention that isn't passed as a model", () => {
    const loose = { ...scan, hits: scan.hits.map((h) => ({ ...h, context: "other" as const })) };
    expect(assessProviderChanges({ records: [record], scan: loose })).toEqual([]);
  });
});
