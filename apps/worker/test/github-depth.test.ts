import { describe, expect, it } from "vitest";
import { matchesTarget, parseCommand } from "../src/jobs/commands";
import { composeDashboard, tickedActions } from "../src/jobs/dashboard";

describe("@teire commands", () => {
  it("reads the first command line, by name or by the App's slug", () => {
    expect(parseCommand("thanks!\n@teire rebase", "teire-bot-dev")).toEqual({
      name: "rebase",
      args: "",
      known: true,
    });
    expect(parseCommand("@teire-bot-dev ignore npm:openai please", "teire-bot-dev")).toEqual({
      name: "ignore",
      args: "npm:openai please",
      known: true,
    });
    expect(parseCommand("@Teire WRONG the call is behind a flag", "teire-bot-dev")).toMatchObject({
      name: "wrong",
      args: "the call is behind a flag",
    });
    expect(parseCommand("@teire dance", "teire-bot-dev")).toMatchObject({ name: "help", known: false });
    expect(parseCommand("cc @teirence", "teire-bot-dev")).toBeNull();
    expect(parseCommand("no mention here", "teire-bot-dev")).toBeNull();
  });

  it("matches a target by change id, group, package (with or without ecosystem) or provider", () => {
    const f = {
      changeId: "npm/openai/4.104.0..5.23.2/symbol-removed",
      dependencyKey: "npm:openai@.",
      groupKey: "npm/openai/5.23.2",
    };
    for (const t of [
      "npm/openai/4.104.0..5.23.2/symbol-removed",
      "npm/openai/5.23.2",
      "openai",
      "npm:openai",
      "npm/openai",
    ])
      expect(matchesTarget(t, f)).toBe(true);
    expect(matchesTarget("pypi:openai", f)).toBe(false);
    expect(
      matchesTarget("provider:groq", { changeId: "x", dependencyKey: "", groupKey: "models/groq" }),
    ).toBe(true);
    expect(matchesTarget("", f)).toBe(false);
  });
});

describe("Dashboard issue", () => {
  const base = {
    fullName: "teire-dev/demo",
    sha: "abcdef1234",
    scannedAt: new Date("2026-10-25T10:00:00Z"),
    status: "active",
    webUrl: "https://teire.vercel.app",
    inventory: [{ ecosystem: "npm", n: 120 }],
    ignores: ["npm:left-pad"],
    configProblems: [".github/teire.yml line 4: upgrades.cooldownDays Invalid input"],
  };
  const finding = (over: Record<string, unknown>) =>
    ({
      id: "1",
      changeId: "c",
      dependencyKey: "npm:openai@.",
      verdict: "affected",
      state: "open",
      priority: 2,
      reason: "removed",
      groupKey: "npm/openai/5.23.2",
      callSites: [{ file: "a.ts", line: 3 }],
      coverage: null,
      position: null,
      title: "openai 5.23.2 removes 3 API(s)",
      kind: "symbol-removed",
      deadline: null,
      ...over,
    }) as never;

  it("lists affected groups with Fix now, PRs with Rebase, ignores with Unignore, and config problems", () => {
    const body = composeDashboard({
      ...base,
      findings: [
        finding({}),
        finding({
          id: "2",
          groupKey: "npm/zod/4.0.0",
          verdict: "not_affected",
          title: "zod 4.0.0",
          callSites: [],
        }),
        finding({
          id: "3",
          groupKey: "models/openai",
          title: "gpt-4.1-nano shuts down",
          deadline: new Date("2026-11-03T00:00:00Z"),
        }),
      ],
      artifacts: [
        { kind: "pr", changeKey: "models/openai", number: 7, url: "https://github.com/x/y/pull/7" },
      ] as never,
    });
    expect(body).toContain("<!-- teire:dashboard -->");
    expect(body).toContain(
      "- [ ] <!-- teire:fix=npm/openai/5.23.2 --> Fix now: **openai 5.23.2 removes 3 API(s)** — 1 site",
    );
    expect(body).toContain("- [ ] <!-- teire:rebase=models/openai --> Rebase [#7]");
    expect(body).toContain("| gpt-4.1-nano shuts down | 2026-11-03 | [PR #7]");
    expect(body).toContain("<details><summary>Not affected (1)</summary>");
    expect(body).toContain("- [ ] <!-- teire:unignore=npm:left-pad --> Unignore `npm:left-pad`");
    expect(body).toContain("line 4: upgrades.cooldownDays");
    // The group with an open PR is not offered again under Affected.
    expect(body).not.toContain("teire:fix=models/openai");
  });

  it("acts only on boxes that went from empty to ticked", () => {
    const before =
      "- [ ] <!-- teire:rescan=now --> Rescan now\n- [x] <!-- teire:fix=npm/a/2.0.0 --> Fix now\n- [ ] <!-- teire:unignore=b --> Unignore";
    const after =
      "- [x] <!-- teire:rescan=now --> Rescan now\n- [x] <!-- teire:fix=npm/a/2.0.0 --> Fix now\n- [X] <!-- teire:unignore=b --> Unignore";
    expect(tickedActions(before, after)).toEqual([
      { kind: "rescan", key: "now" },
      { kind: "unignore", key: "b" },
    ]);
  });
});

describe("fix job group keys", () => {
  it("maps every package ecosystem by its contract name, and no provider group", async () => {
    const { packageEcosystemOf } = await import("../src/jobs/fix");
    for (const e of ["npm", "pypi", "go", "cargo", "rubygems", "maven"])
      expect(packageEcosystemOf(e)).toBe(e);
    expect(packageEcosystemOf("models")).toBeNull();
    expect(packageEcosystemOf("api")).toBeNull();
    expect(packageEcosystemOf("runtime")).toBeNull();
  });
});
