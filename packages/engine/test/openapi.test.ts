import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deepResponseChange, fileRank, indexSpec, matchOperations, pinnedApiVersion } from "../src/openapi";

const spec = indexSpec({
  servers: [{ url: "https://api.stripe.com/" }],
  paths: {
    "/v1/customers/{customer}": { get: { operationId: "GetCustomersCustomer" } },
    "/v1/customers/search": { get: { operationId: "GetCustomersSearch" } },
    "/v1/checkout/sessions": { post: { operationId: "PostCheckoutSessions" }, get: {} },
    "/responses/compact?beta=true": { post: {} },
  },
});

describe("which operation a call reaches", () => {
  it("matches templates, most specific first, any method when unknown", () => {
    expect(spec.hosts).toEqual(["api.stripe.com"]);
    expect(matchOperations(spec, "/v1/customers/search").map((o) => o.operationId)).toEqual([
      "GetCustomersSearch",
    ]);
    expect(matchOperations(spec, "/v1/customers/cus_123").map((o) => o.operationId)).toEqual([
      "GetCustomersCustomer",
    ]);
    expect(
      matchOperations(spec, "/v1/checkout/sessions")
        .map((o) => o.method)
        .sort(),
    ).toEqual(["GET", "POST"]);
    expect(matchOperations(spec, "/v1/checkout/sessions", "post").map((o) => o.method)).toEqual(["POST"]);
    expect(matchOperations(spec, "/responses/compact")[0]?.path).toBe("/responses/compact");
    expect(matchOperations(spec, "/v2/unknown")).toEqual([]);
  });
});

describe("spec files and noise", () => {
  it("prefers the description named for the host, never SDK or dereferenced variants", () => {
    const host = "api.github.com";
    const files = [
      "descriptions/api.github.com/api.github.com.json",
      "descriptions/api.github.com/dereferenced/api.github.com.deref.json",
      "descriptions/ghes-3.9/ghes-3.9.json",
    ].sort((a, b) => fileRank(a, host) - fileRank(b, host));
    expect(files[0]).toBe("descriptions/api.github.com/api.github.com.json");
    expect(fileRank("openapi/spec3.json", "api.stripe.com")).toBeLessThan(
      fileRank("openapi/spec3.sdk.json", "api.stripe.com"),
    );
    expect(fileRank("openapi/fixtures3.json", "api.stripe.com")).toBe(99);
  });

  it("drops response changes deep inside expansions, keeps request and shallow response changes", () => {
    expect(
      deepResponseChange({
        id: "response-property-type-changed",
        text: "the `data/items/automatic_tax/liability/anyOf[subschema #1: X]/account` response's property `type` changed",
      }),
    ).toBe(true);
    expect(
      deepResponseChange({ id: "response-property-removed", text: "removed the `url` response property" }),
    ).toBe(false);
    expect(
      deepResponseChange({
        id: "request-property-removed",
        text: "removed the request property `a/b/c/d/e`",
      }),
    ).toBe(false);
  });
});

describe("the repo's position on a date-versioned API", () => {
  it("reads the API version a repo pins", () => {
    const dir = mkdtempSync(join(tmpdir(), "teire-pin-"));
    writeFileSync(join(dir, "a.ts"), `headers: { "Stripe-Version": "2026-08-26.dahlia" }`);
    writeFileSync(join(dir, "b.py"), `stripe.api_version = "2024-06-20"`);
    writeFileSync(join(dir, "c.ts"), `const released = "2024-06-20";`);
    expect(pinnedApiVersion(dir, ["a.ts"])).toEqual({ version: "2026-08-26.dahlia", file: "a.ts" });
    expect(pinnedApiVersion(dir, ["b.py"])?.version).toBe("2024-06-20");
    expect(pinnedApiVersion(dir, ["c.ts"])).toBeNull();
  });
});
