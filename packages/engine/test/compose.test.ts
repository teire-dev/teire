import { describe, expect, it } from "vitest";
import { branchFor } from "../src/github/commit";
import {
  blockquote,
  changeSummary,
  composeHumanIssue,
  displayQuote,
  fitBody,
  joinBlocks,
  sanitizeUpstream,
} from "../src/github/compose";

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

  it("summarises a surface record without its package and version, also across a Go major", () => {
    expect(changeSummary("openai 4.104.0 → 7.38.0: removes 3 API(s)", "openai")).toBe("removes 3 API(s)");
    expect(
      changeSummary(
        "com.squareup.okhttp3:okhttp 3.14.9 → 5.5.0: removes 133 API(s)",
        "com.squareup.okhttp3:okhttp",
      ),
    ).toBe("removes 133 API(s)");
    expect(changeSummary("openai 7.38.0 removes 3 API(s)", "openai")).toBe("removes 3 API(s)");
    expect(
      changeSummary("github.com/golang-jwt/jwt/v4 v5.3.1 removes 34 API(s)", "github.com/golang-jwt/jwt/v4"),
    ).toBe("removes 34 API(s)");
  });
});

describe("branch names", () => {
  it("are valid git refs for every ecosystem's package names", () => {
    expect(branchFor("maven/org.springframework.boot:spring-boot-starter-parent/4.1.0")).toBe(
      "teire/maven/org.springframework.boot-spring-boot-starter-parent/4.1.0",
    );
    expect(branchFor("npm/@types/react/19.3.0")).toBe("teire/npm/types/react/19.3.0");
    expect(branchFor("go/github.com/golang-jwt/jwt/v5/5.3.0")).toBe(
      "teire/go/github.com/golang-jwt/jwt/v5/5.3.0",
    );
    expect(branchFor("models/openai")).toBe("teire/models/openai");
    expect(branchFor("pypi/.hidden/1.0.")).toBe("teire/pypi/dot-hidden/1.0");
  });
});

describe("upstream text in PR bodies", () => {
  const up = { owner: "colinhacks", repo: "zod" };
  it("never pings people or back-references upstream threads", () => {
    const out = sanitizeUpstream(
      "Thanks @alice-b and @bob! See #123, vercel/next.js#99 and https://github.com/colinhacks/zod/pull/42.",
      up,
    );
    expect(out).toContain("`@​alice-b`");
    expect(out).toContain("`@​bob`");
    expect(out).toContain("[colinhacks/zod#123](https://redirect.github.com/colinhacks/zod/issues/123)");
    expect(out).toContain("[vercel/next.js#99](https://redirect.github.com/vercel/next.js/issues/99)");
    expect(out).toContain("https://redirect.github.com/colinhacks/zod/pull/42");
    expect(out).not.toMatch(/(^|\s)@alice/);
  });
  it("leaves emails alone, shows HTML as text, and keeps every quoted line inside the quote", () => {
    expect(sanitizeUpstream("mail me@example.com", up)).toBe("mail me@example.com");
    expect(sanitizeUpstream("<details>x</details>", up)).toBe("&lt;details>x&lt;/details>");
    expect(sanitizeUpstream("see #7", null)).toBe("see #​7");
    expect(blockquote("a\nb")).toBe("> a\n> b");
  });
  it("cuts a long body at a block boundary and says so", () => {
    const body = `${"a".repeat(50)}\n\n${"b".repeat(50)}`;
    const out = fitBody(body, 90, "https://teire.vercel.app/runs/1");
    expect(out.startsWith("a".repeat(50))).toBe(true);
    expect(out).toContain("Description shortened");
    expect(out.length).toBeLessThanOrEqual(90 + 120);
  });
});

describe("needs-a-human issues", () => {
  it("say why, where and what to do, with upstream text sanitised", () => {
    const { title, body } = composeHumanIssue({
      repo: { owner: "teire-lab", repo: "coal", baseSha: "abc123" },
      key: "advisory/rubygems/rack/GHSA-x",
      rows: [
        {
          changeId: "advisory/rubygems/rack/GHSA-x",
          title: "rack: header injection",
          verdict: "affected",
          reason: "no fixed version is published",
          callSites: [{ file: "lib/app.rb", line: 12, snippet: "Rack::Utils.parse_query(q)" }],
        },
      ],
      records: [],
      webUrl: "https://teire.vercel.app/app/repos/teire-lab/coal",
    });
    expect(title).toBe("Teire needs a human: rack: header injection");
    expect(body).toContain("no fixed version is published");
    expect(body).toContain("lib/app.rb:12");
    expect(body).toContain("`@teire fix advisory/rubygems/rack/GHSA-x`");
  });
});
