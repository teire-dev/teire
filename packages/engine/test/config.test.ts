import { describe, expect, it } from "vitest";
import { CATALOG_SCHEMA_VERSION } from "../src/catalog/schema";
import { toChangeV2 } from "../src/catalog/v2";
import { readTeireConfig } from "../src/config";
import { DEFAULT_CONFIG } from "../src/github/compose";
import { memoryTree } from "../src/inventory/tree";
import { githubSpecLocation } from "../src/openapi";
import { declaredProviders } from "../src/pipeline/api";

describe("teire.yml sources", () => {
  it("keeps host or package entries with https URLs and reports the rest", () => {
    const config = readTeireConfig(
      memoryTree({
        ".github/teire.yml": [
          "sources:",
          "  - host: api.acme.dev",
          "    changelogUrl: https://docs.acme.dev/changelog",
          "  - host: api.acme.dev",
          "    specUrl: https://github.com/acme/api-spec/blob/main/openapi.yaml",
          "  - package: left-pad",
          "    changelogUrl: http://insecure.example/changes",
          "  - changelogUrl: https://docs.acme.dev/changelog",
        ].join("\n"),
      }),
    );
    expect(config.sources).toEqual([
      { host: "api.acme.dev", changelogUrl: "https://docs.acme.dev/changelog" },
      { host: "api.acme.dev", specUrl: "https://github.com/acme/api-spec/blob/main/openapi.yaml" },
    ]);
    expect(config.problems).toHaveLength(2);
  });

  it("reads a declared changelog as a private, repo-trusted provider", () => {
    const [use] = declaredProviders([
      { host: "api.acme.dev", changelogUrl: "https://docs.acme.dev/changelog" },
    ]);
    expect(use?.provider.officialDomains).toEqual(["acme.dev"]);
    expect(use?.provider.sources[0]?.adapter).toBe("discovered");
    if (!use) throw new Error("no provider");
    const record = toChangeV2(
      {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        id: "x-2026-01-01-old-model",
        provider: use.provider.slug,
        kind: "model-retirement",
        title: "old-model shutdown",
        summary: "Shutdown date: 2026-01-01.",
        announcedOn: null,
        effectiveOn: "2026-01-01",
        breaking: true,
        signatures: {
          modelIds: ["old-model"],
          params: [],
          endpoints: [],
          symbols: [],
          packages: [],
          apiVersions: [],
        },
        replacement: null,
        migrationNotes: [],
        sources: [
          {
            url: "https://docs.acme.dev/changelog",
            quote: "old-model shuts down 2026-01-01",
            contentHash: "0".repeat(64),
            checkedAt: new Date().toISOString(),
          },
        ],
        extraction: { method: "model", model: "m" },
        status: "confirmed",
        quarantineReasons: [],
      },
      use.provider,
    );
    expect(record.visibility).toBe("private");
    expect(record.sources[0]?.trustBasis).toBe("repo-config");
    expect(record.sources[0]?.kind).toBe("repo-declared");
  });

  it("takes declared specs from GitHub file URLs, whose history gives the revisions", () => {
    expect(githubSpecLocation("https://github.com/acme/api-spec/blob/main/specs/openapi.yaml")).toEqual({
      repo: "acme/api-spec",
      branch: "main",
      path: "specs/openapi.yaml",
    });
    expect(
      githubSpecLocation("https://raw.githubusercontent.com/acme/api-spec/main/openapi.json")?.path,
    ).toBe("openapi.json");
    expect(githubSpecLocation("https://docs.acme.dev/openapi.json")).toBeNull();
  });
});

describe("the onboarding teire.yml", () => {
  it("is valid against Teire's own schema and turns on the daily schedule", () => {
    const config = readTeireConfig(memoryTree({ ".github/teire.yml": DEFAULT_CONFIG }));
    expect(config.problems).toEqual([]);
    expect(config.schedule).toBe("daily");
    expect(readTeireConfig(memoryTree({})).schedule).toBe("daily");
  });
});
