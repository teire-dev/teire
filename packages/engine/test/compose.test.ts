import { describe, expect, it } from "vitest";
import { branchFor } from "../src/github/commit";
import {
  blockquote,
  changeSummary,
  composeHumanIssue,
  composeOnboarding,
  displayQuote,
  fitBody,
  joinBlocks,
  link,
  safeUrl,
  sanitizeUpstream,
  upgradeGroups,
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
      "teire/maven/org.springframework.boot/spring-boot-starter-parent/4.1.0",
    );
    // Two coordinates Dependabot's naming would merge, and a component git refuses.
    expect(branchFor("maven/a:b-c/1.0")).not.toBe(branchFor("maven/a-b:c/1.0"));
    expect(branchFor("maven/com.example:a.lock/1.0.0")).toBe("teire/maven/com.example/a-lock/1.0.0");
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
  it("cuts a long body at whole blocks, closes an open <details>, and says so", () => {
    const run = "https://teire.vercel.app/runs/1";
    const body = `${"a".repeat(50)}\n\n${"b".repeat(200)}`;
    const out = fitBody(body, 220, run);
    expect(out.startsWith("a".repeat(50))).toBe(true);
    expect(out).not.toContain("bbbbb");
    expect(out).toContain("Description shortened");
    expect(out.length).toBeLessThanOrEqual(220);
    const table = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |";
    const folded = fitBody(
      `<details><summary>x</summary>\n\n${table}\n\n${"c".repeat(400)}\n\n</details>`,
      300,
      run,
    );
    expect(folded).toContain(table);
    expect(folded.match(/<details>/g)?.length).toBe(folded.match(/<\/details>/g)?.length);
    expect(folded.indexOf("</details>")).toBeLessThan(folded.indexOf("Description shortened"));
  });
  it("links only http(s) URLs", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl("https://example.com/a (b)")).toBe("https://example.com/a%20%28b%29");
    expect(link("source", "data:text/html,x")).toBe("source");
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

describe("onboarding upgrades", () => {
  const row = (dir: string, version: string, verdict: "affected" | "not_affected", sites: number) => ({
    instance: {
      ecosystem: "pypi" as const,
      name: "anthropic",
      version,
      direct: true,
      scope: "runtime" as const,
      workspace: ".",
      manifestPath: `${dir}/pyproject.toml`,
      lockfilePath: `${dir}/uv.lock`,
      source: "registry" as const,
      resolvedBy: "lockfile" as const,
    },
    target: "1.17.0",
    majorsBehind: 1,
    deprecated: null,
    verdict,
    breakingSites: sites,
    coverage: null,
  });

  it("lists a package once per target across lockfile roots", () => {
    const groups = upgradeGroups([
      row("py-major", "0.125.0", "affected", 3),
      row("py-live", "0.125.0", "not_affected", 0),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      name: "anthropic",
      from: ["0.125.0"],
      projects: ["py-major", "py-live"],
      verdict: "affected",
      breakingSites: 3,
    });
    const { body } = composeOnboarding({
      repo: { owner: "o", repo: "r" },
      rows: [row("py-major", "0.125.0", "affected", 3), row("py-live", "0.125.0", "not_affected", 0)],
    });
    expect(body.match(/\| `anthropic` \| 0\.125\.0 → 1\.17\.0/g)).toHaveLength(1);
    expect(body).toContain("across 2 projects");
  });
});
