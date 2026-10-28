import { describe, expect, it } from "vitest";
import { describeAction, undoOf } from "../src/actions";
import { parseAction } from "../src/actions-schema";

// U1 (D121): one typed allow-list; the web records only what it accepts and the worker re-checks.
describe("actions", () => {
  it("accepts a known kind with exactly its params, and nothing else", () => {
    expect(parseAction("set-fix-mode", { mode: "ask" })).toMatchObject({ ok: true, params: { mode: "ask" } });
    expect(parseAction("set-fix-mode", { mode: null })).toMatchObject({ ok: true });
    expect(parseAction("set-fix-mode", { mode: "sometimes" }).ok).toBe(false);
    expect(parseAction("fix", { target: "zod", merge: true }).ok).toBe(false);
    expect(parseAction("merge", {}).ok).toBe(false);
    expect(parseAction("cancel-run", { runId: "not-a-uuid" }).ok).toBe(false);
  });

  it("undoes what can be undone, and names each action", () => {
    expect(undoOf("pause", {})).toEqual({ kind: "resume", params: {} });
    expect(undoOf("ignore", { target: "zod" })).toEqual({ kind: "unignore", params: { target: "zod" } });
    expect(undoOf("set-fix-mode", { mode: "off" }, { mode: null })).toEqual({
      kind: "set-fix-mode",
      params: { mode: null },
    });
    expect(undoOf("fix", { target: "zod" })).toBeNull();
    expect(describeAction("set-fix-mode", { mode: "ask" })).toBe("Set fix mode to Ask first");
  });
});
