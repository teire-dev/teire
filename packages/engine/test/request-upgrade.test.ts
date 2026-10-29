import { describe, expect, it } from "vitest";
import { type AgentWorkspace, agentTools } from "../src/fix/agent";

const workspace = (extra: Partial<AgentWorkspace> = {}): AgentWorkspace => ({
  repoDir: "/nowhere",
  allowed: new Set(),
  changed: new Set(),
  check: async () => ({ passed: true, text: "" }),
  docs: async () => "",
  ...extra,
});

describe("request_upgrade (S15.2)", () => {
  it("is offered only where dependabot-core's updater may move another dependency", () => {
    expect(Object.keys(agentTools(workspace()))).not.toContain("request_upgrade");
    expect(Object.keys(agentTools(workspace({ requestUpgrade: async () => "" })))).toContain(
      "request_upgrade",
    );
  });

  it("hands the agent's call to the run, which answers in words", async () => {
    const calls: [string, string, string][] = [];
    const ws = workspace({
      requestUpgrade: async (name, version, why) => {
        calls.push([name, version, why]);
        return `${name} is now 1.2.0, installed. Call run_check.`;
      },
    });
    const tool = agentTools(ws).request_upgrade as unknown as {
      execute: (
        input: { dependency: string; version: string; why: string },
        options: unknown,
      ) => Promise<string>;
    };
    const said = await tool.execute(
      { dependency: "http", version: "1.2.0", why: "reqwest 0.12 takes http 1.x types" },
      { toolCallId: "t1", messages: [] },
    );
    expect(calls).toEqual([["http", "1.2.0", "reqwest 0.12 takes http 1.x types"]]);
    expect(said).toContain("installed");
  });
});
