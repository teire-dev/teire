import { describe, expect, it } from "vitest";
import { type ExtractionResult, noteRecords } from "../src/notes/extract";
import { rawFileUrl } from "../src/notes/sources";

describe("a changelog the repository names in teire.yml (S16.1)", () => {
  it("reads a GitHub or GitLab file page as its raw file", () => {
    expect(rawFileUrl("https://github.com/acme/sdk/blob/main/CHANGELOG.md")).toBe(
      "https://raw.githubusercontent.com/acme/sdk/main/CHANGELOG.md",
    );
    expect(rawFileUrl("https://gitlab.com/group/sub/sdk/-/blob/v2.0.0/CHANGES.md")).toBe(
      "https://gitlab.com/group/sub/sdk/-/raw/v2.0.0/CHANGES.md",
    );
    expect(rawFileUrl("https://docs.acme.dev/changelog.md")).toBe("https://docs.acme.dev/changelog.md");
  });

  it("keeps its behaviour records private, under the package's own ecosystem (D53)", () => {
    const source = (trustBasis: "repo-config" | "source-repo") => ({
      kind: "changelog" as const,
      url: "https://docs.acme.dev/changelog.md",
      trustBasis,
      text: "",
      contentHash: "a".repeat(64),
      checkedAt: "2026-10-29T00:00:00.000Z",
    });
    const extraction = (trustBasis: "repo-config" | "source-repo") =>
      ({
        items: [
          {
            kind: "behaviour-change",
            summary: "Timeouts now default to 30 seconds",
            apis: [],
            replacement: null,
            quote: "timeouts now default to 30 seconds",
            source: source(trustBasis),
          },
        ],
        receipt: { model: "nvidia/Nemotron-3-Ultra-550b-a55b" },
        promptHash: "p",
      }) as unknown as ExtractionResult;
    const [declared] = noteRecords(extraction("repo-config"), {
      name: "acme-sdk",
      from: "1.0.0",
      to: "2.0.0",
      ecosystem: "pypi",
    });
    expect(declared?.visibility).toBe("private");
    expect(declared?.subject).toMatchObject({ ecosystem: "pypi", name: "acme-sdk" });
    expect(declared?.id.startsWith("pypi/acme-sdk/")).toBe(true);
    const [found] = noteRecords(extraction("source-repo"), {
      name: "acme-sdk",
      from: "1.0.0",
      to: "2.0.0",
      ecosystem: "pypi",
    });
    expect(found?.visibility).toBe("public");
  });
});
