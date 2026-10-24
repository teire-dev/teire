import { describe, expect, it } from "vitest";
import { quoteInSource, sliceChangelog, versionHeadings } from "../src/notes";
import { npmScheme } from "../src/registry";

// Heading shapes taken from real changelogs (cross-cutting.md §7.3): release-please (openai),
// stripe's "version - date", keep-a-changelog, setext (requests), "Version x" (okhttp).
const releasePlease = `# Changelog

## [5.23.2](https://github.com/openai/openai-node/compare/v5.23.1...v5.23.2) (2025-09-29)

### Bug Fixes

* **api:** fix a thing

## [5.0.0](https://github.com/openai/openai-node/compare/v4.104.0...v5.0.0) (2025-06-01)

See MIGRATION.md. Version 4.104.0 is mentioned in prose.

## 4.104.0 (2025-05-29)

* older
`;

describe("changelog slicer", () => {
  it("slices (from, to] at the most common version heading level", () => {
    const entries = sliceChangelog(releasePlease, npmScheme, "4.104.0", "5.23.2");
    expect(entries.map((e) => e.version)).toEqual(["5.23.2", "5.0.0"]);
    expect(entries[0]?.body).toContain("### Bug Fixes");
    expect(entries[1]?.body).toContain("See MIGRATION.md");
  });

  it("reads stripe, keep-a-changelog, setext and 'Version x' headings", () => {
    const heads = (md: string) => versionHeadings(md, npmScheme).map((h) => h.version);
    expect(heads("## 18.5.0 - 2025-08-27\n* a\n## 18.4.0 - 2025-08-01\n")).toEqual(["18.5.0", "18.4.0"]);
    expect(heads("## [1.2.3] - 2026-01-02\n### Added\n- x\n## [1.2.2] - 2025-12-01\n")).toEqual([
      "1.2.3",
      "1.2.2",
    ]);
    expect(
      heads(
        "2.34.2 (2026-05-14)\n-------------------\n\n- fix\n\n2.34.1 (2026-04-01)\n-------------------\n",
      ),
    ).toEqual(["2.34.2", "2.34.1"]);
    expect(heads("## Version 5.5.1\n_2026-01-01_\n## Version 5.5.0\n")).toEqual(["5.5.1", "5.5.0"]);
    expect(heads("```md\n## 9.9.9\n```\n## 1.0.0\n")).toEqual(["1.0.0"]);
  });
});

describe("quote gate for prose", () => {
  const guide = `## Removed \`httpAgent\`

The \`httpAgent\` client option has been removed in favor of a platform-specific \`fetchOptions\` property.

\`\`\`ts
// Before
const client = new OpenAI({ httpAgent: new HttpsProxyAgent(process.env.PROXY_URL) });
\`\`\`

## Environment requirements

The minimum supported runtime and tooling versions are now: Node.js 22 LTS.`;

  it("accepts verbatim text across stripped markdown, and marks skipped text", () => {
    expect(
      quoteInSource(
        "The `httpAgent` client option has been removed in favor of a platform-specific `fetchOptions` property. // Before const client",
        guide,
      ),
    ).not.toBeNull();
    const joined = quoteInSource(
      "The `httpAgent` client option has been removed in favor of a platform-specific `fetchOptions` property. The minimum supported runtime and tooling versions are now: Node.js 22 LTS.",
      guide,
    );
    expect(joined).toContain(" … ");
  });

  it("refuses words the source does not contain", () => {
    expect(quoteInSource("The `httpAgent` client option was renamed to `agent`.", guide)).toBeNull();
    expect(quoteInSource("short", guide)).toBeNull();
  });
});
