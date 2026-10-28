import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { underTimeout } from "../src/verify/tokenfactory";

// Review R24: each Token Factory command runs under GNU `timeout`, quoted for `sh -c`.
describe("underTimeout", () => {
  it("wraps the command so its quoting survives and a hang ends with 124", () => {
    const cmd = underTimeout(`cd /tmp && exec echo 'it'"'"'s fine'`, 5);
    expect(cmd.startsWith("timeout -k 10 5 sh -c ")).toBe(true);
    expect(execFileSync("sh", ["-c", cmd.replace(/^timeout -k 10 5 /, "")]).toString()).toBe("it's fine\n");
  });
});
