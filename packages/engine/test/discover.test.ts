import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chunksOf } from "../src/catalog/adapters/vendor-page";
import { quoteAppearsIn } from "../src/catalog/markdown";
import { PROVIDERS } from "../src/catalog/providers";
import { datesIn } from "../src/catalog/v2";
import {
  allowlistOf,
  apiHostsIn,
  htmlToText,
  isApiEndpoint,
  linkScope,
  llmsLinks,
  providerCandidates,
  registrableDomain,
  sdkIsFor,
} from "../src/discover";
import { memoryCache } from "../src/registry";

describe("provider domains", () => {
  it("uses the public suffix list, never a string suffix", () => {
    expect(registrableDomain("api.groq.com")).toBe("groq.com");
    expect(registrableDomain("api.tokenfactory.us-central1.nebius.com")).toBe("nebius.com");
    expect(registrableDomain("stripe.com.evil.io")).toBe("evil.io");
    // Private suffixes keep each tenant apart.
    expect(registrableDomain("owner.github.io")).toBe("owner.github.io");
    expect(registrableDomain("127.0.0.1")).toBeNull();
    expect(registrableDomain("localhost")).toBeNull();
  });

  it("tells API endpoints from links, images and local hosts", () => {
    expect(isApiEndpoint("api.groq.com", "/openai/v1")).toBe(true);
    expect(isApiEndpoint("api-inference.together.ai")).toBe(true);
    expect(isApiEndpoint("example.io", "/v1/chat/completions")).toBe(true);
    expect(isApiEndpoint("cohere.com", "/favicon-32x32.png")).toBe(false);
    expect(isApiEndpoint("docs.mistral.ai", "/getting-started")).toBe(false);
    expect(isApiEndpoint("api.example.com", "/v1")).toBe(false);
    expect(isApiEndpoint("api.internal", "/v1")).toBe(false);
    expect(isApiEndpoint("localhost", "/v1")).toBe(false);
  });

  it("reads package links as domains, or repository prefixes on code hosts", () => {
    expect(linkScope("https://docs.together.ai/")).toEqual({ domain: "together.ai" });
    expect(linkScope("git+https://github.com/groq/groq-typescript.git")).toEqual({
      repoPrefix: "github.com/groq/groq-typescript",
    });
    expect(linkScope("https://www.npmjs.com/package/groq-sdk")).toBeNull();
    expect(
      allowlistOf({
        domain: "together.ai",
        sdks: [
          {
            ecosystem: "npm",
            name: "together-ai",
            version: "1.0.0",
            hosts: [],
            links: [
              "https://docs.together.ai/",
              "git+https://github.com/togethercomputer/together-typescript.git",
            ],
            filesRead: 0,
          },
        ],
      }),
    ).toEqual({ domains: ["together.ai"], repos: ["github.com/togethercomputer/together-typescript"] });
  });

  it("attributes an SDK only to the API its name or its own links point at", () => {
    const profile = (name: string, links: string[] = []) => ({ name, links });
    expect(sdkIsFor(profile("groq-sdk"), "api.groq.com")).toBe(true);
    expect(sdkIsFor(profile("@mistralai/mistralai"), "api.mistral.ai")).toBe(true);
    expect(sdkIsFor(profile("my-client", ["https://docs.acme.dev"]), "api.acme.dev")).toBe(true);
    // A framework that mentions another company's API is not that company's SDK.
    expect(sdkIsFor(profile("next", ["https://nextjs.org"]), "api.vercel.com")).toBe(false);
  });
});

describe("SDK base URLs", () => {
  it("counts API hosts in a package's code, skipping tests, docs and non-API links", () => {
    const dir = mkdtempSync(join(tmpdir(), "teire-sdk-"));
    mkdirSync(join(dir, "lib"));
    mkdirSync(join(dir, "tests"));
    writeFileSync(
      join(dir, "lib", "client.js"),
      `const base = "https://api.groq.com"; const docs = "https://console.groq.com/docs";`,
    );
    writeFileSync(join(dir, "lib", "core.mjs"), "fetch(`https://api.groq.com`)");
    writeFileSync(join(dir, "tests", "client.test.js"), `"https://api.other.com/v1"`);
    writeFileSync(join(dir, "lib", "types.d.ts"), `"https://api.typed.com/v1"`);
    expect(apiHostsIn(dir, "npm").hosts).toEqual([{ host: "api.groq.com", count: 2 }]);
  });

  it("makes a candidate from a host in the code unless a curated reader covers it", async () => {
    const candidates = await providerCandidates({
      urls: [
        { host: "api.mistral.ai", path: "/v1/chat/completions" },
        { host: "api.openai.com", path: "/v1/responses" },
        { host: "github.com", path: "/teire-dev/teire" },
      ],
      instances: [],
      known: PROVIDERS,
      options: { cache: memoryCache() },
    });
    expect(candidates.map((c) => [c.domain, c.via])).toEqual([["mistral.ai", ["api.mistral.ai"]]]);
  });
});

describe("notice pages", () => {
  it("takes llms.txt link titles, not their descriptions", () => {
    const text = [
      "# Mistral AI",
      "- [Model lifecycle policy](https://docs.mistral.ai/inference/model-lifecycle.md)",
      "- [Supported Models](https://console.groq.com/docs/models): production, preview and deprecated models",
    ].join("\n");
    expect(llmsLinks(text)).toEqual([
      { title: "Model lifecycle policy", url: "https://docs.mistral.ai/inference/model-lifecycle.md" },
      { title: "Supported Models", url: "https://console.groq.com/docs/models" },
    ]);
  });

  it("reduces HTML to text with table rows a quote can match", () => {
    const html =
      "<html><head><title>x</title></head><body><script>var a=1</script><h2>Deprecations</h2><table><tr><th>Model</th><th>Shutdown</th></tr><tr><td>llama-3.1-8b-instant</td><td>08/16/26</td></tr></table><p>Use&nbsp;the &amp; replacement</p></body></html>";
    const text = htmlToText(html);
    expect(text).toContain("## Deprecations");
    expect(text).toContain("| llama-3.1-8b-instant | 08/16/26 |");
    expect(text).toContain("Use the & replacement");
    expect(text).not.toContain("var a");
  });

  it("splits long pages at headings", () => {
    const section = (n: number) => `## Section ${n}\n${"x".repeat(20_000)}`;
    const chunks = chunksOf([section(1), section(2), section(3)].join("\n"));
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.startsWith("## Section"))).toBe(true);
  });
});

describe("the gate's date and quote checks", () => {
  it("reads the dates providers write", () => {
    expect(datesIn("| llama-3.1-8b-instant | 08/16/26 | openai/gpt-oss-20b |")).toContain("2026-08-16");
    expect(datesIn("will be decommissioned on September 21, 2026.")).toEqual(["2026-09-21"]);
    expect(datesIn("retired on 16 August 2026")).toEqual(["2026-08-16"]);
    expect(datesIn("shut down 2026‑05‑12 and 2026-06-01")).toEqual(["2026-05-12", "2026-06-01"]);
    // Ambiguous numeric dates allow both readings; impossible ones allow neither.
    expect(datesIn("on 03/04/2026").sort()).toEqual(["2026-03-04", "2026-04-03"]);
    expect(datesIn("version 1/2/3")).toEqual([]);
  });

  it("checks each part of a quote that skips text, in order", () => {
    const page =
      "Both systems will be decommissioned on September 21, 2026. Beginning on that date, requests fail.";
    expect(quoteAppearsIn("Both systems will be decommissioned … requests fail.", page)).toBe(true);
    expect(quoteAppearsIn("requests fail. … Both systems will be decommissioned", page)).toBe(false);
    expect(quoteAppearsIn("Both systems … were never retired", page)).toBe(false);
  });
});

describe("base URLs the deployment sets", () => {
  it("finds env-set client base URLs and names the provider they belong to", async () => {
    const { findBaseUrlOverrides } = await import("../src/locate/base-url");
    const { overrideOwner } = await import("../src/impact/provider");
    const { directoryTree } = await import("../src/inventory");
    const dir = join(__dirname, "..", "..", "..", "fixtures", "literals");
    const found = findBaseUrlOverrides(dir, directoryTree(dir));
    expect(found.map((o) => [o.file, o.envVar])).toEqual([["src/chat.ts", "OPENAI_BASE_URL"]]);
    const openai = PROVIDERS.find((p) => p.slug === "openai");
    const tokenFactory = PROVIDERS.find((p) => p.slug === "nebius-token-factory");
    if (!openai || !tokenFactory) throw new Error("curated readers missing");
    expect(overrideOwner("OPENAI_BASE_URL", openai)).toBe(true);
    expect(overrideOwner("OPENAI_BASE_URL", tokenFactory)).toBe(false);
    expect(overrideOwner("GROQ_BASE_URL", { name: "Groq", detection: { envVars: [] } })).toBe(true);
    expect(overrideOwner("DATABASE_URL", openai)).toBe(false);
  });
});
