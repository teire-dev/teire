import { describe, expect, it } from "vitest";
import { providersUsed } from "../src/pipeline/api";

describe("providers from every ecosystem's SDKs (S16.1)", () => {
  const used = (ecosystem: string, name: string) =>
    providersUsed([{ ecosystem, name } as never], new Set()).map((u) => u.provider.slug);

  it("finds OpenAI from its Go, Java, Ruby and Rust SDKs, any Go major", () => {
    expect(used("go", "github.com/openai/openai-go/v3")).toContain("openai");
    expect(used("go", "github.com/openai/openai-go")).toContain("openai");
    expect(used("maven", "com.openai:openai-java")).toContain("openai");
    expect(used("rubygems", "ruby-openai")).toContain("openai");
    expect(used("cargo", "async-openai")).toContain("openai");
  });

  it("does not match a different module that only shares a prefix", () => {
    expect(used("go", "github.com/openai/openai-go-extras")).toEqual([]);
    expect(used("go", "github.com/stripe/stripe-go/v84")).toEqual(["stripe"]);
  });

  it("leaves OpenAI-compatible providers to their host (Token Factory needs its URL)", () => {
    expect(used("go", "github.com/openai/openai-go/v3")).not.toContain("nebius-token-factory");
  });
});
