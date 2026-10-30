import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upgradeRequester } from "../src/fix/request-upgrade";
import type { RequestUpgrade } from "../src/fix/transaction";

const LOCK = "Cargo.lock";

/** A run's state and an after sandbox whose installs exit with the codes given, in order. */
function harness(installExits: number[], answer: Awaited<ReturnType<RequestUpgrade>>) {
  const repoDir = mkdtempSync(join(tmpdir(), "teire-request-"));
  writeFileSync(join(repoDir, LOCK), "rand 0.8.5\n");
  const exits = [...installExits];
  const commands: string[] = [];
  const asked: Parameters<RequestUpgrade>[0][] = [];
  const state = {
    transactionFiles: new Set([LOCK]),
    originals: new Map([[LOCK, "rand 0.8.4\n"]]),
    landed: new Map([[LOCK, "rand 0.8.5\n"]]),
    extraMoved: [] as { name: string; from: string | null; to: string | null; removed: boolean }[],
  };
  const requester = upgradeRequester({
    ask: async (request) => {
      asked.push(request);
      return answer;
    },
    after: {
      run: async (label: string) => {
        commands.push(label);
        const exitCode = label.includes("install") ? (exits.shift() ?? 0) : 0;
        return {
          exitCode,
          stdout: "",
          stderr: exitCode ? "error: failed to select a version" : "",
          ms: 5,
        } as never;
      },
      writeFile: async () => undefined,
      setPhase: async () => undefined,
    } as never,
    plan: { install: ["cargo", "fetch"], cwd: "/work" } as never,
    repoDir,
    binaryPaths: new Set(),
    movedBefore: [{ name: "rand", from: "0.8.4", to: "0.8.5", removed: false, directory: null }] as never,
    remember: (path) => {
      if (!state.originals.has(path)) state.originals.set(path, readFileSync(join(repoDir, path), "utf8"));
    },
    emit: () => undefined,
    clip: (t) => t,
    ...state,
  } as never);
  return { repoDir, requester, commands, asked, state };
}

const moved = (files: { path: string; content: string | null }[]) =>
  ({
    ok: true,
    to: "0.9.1",
    files,
    moved: [{ name: "rand_core", from: "0.6.4", to: "0.9.1", removed: false, directory: null }],
  }) as Awaited<ReturnType<RequestUpgrade>>;

describe("an upgrade the agent asks for, installed and put back when it fails (S15.2)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("sends the run's dependency files and what the run already moved it to", async () => {
    const h = harness([0], moved([{ path: LOCK, content: "rand_core 0.9.1\n" }]));
    dirs.push(h.repoDir);
    expect(await h.requester.ask("rand_core", "0.9.1", "rand 0.9 needs it")).toContain(
      "rand_core is now 0.9.1",
    );
    await h.requester.ask("rand", "0.9.0", "check");
    expect(h.asked[0]?.files).toEqual({ [LOCK]: "rand 0.8.5\n" });
    expect(h.asked[1]?.current).toBe("0.8.5");
    expect(h.state.extraMoved[0]).toMatchObject({ name: "rand_core", requested: "rand 0.9 needs it" });
  });

  it("puts the files back, drops a file the request added, and says why", async () => {
    const h = harness(
      [1, 0],
      moved([
        { path: LOCK, content: "rand_core 0.9.1\n" },
        { path: "vendor.lock", content: "added\n" },
      ]),
    );
    dirs.push(h.repoDir);
    const said = await h.requester.ask("rand_core", "0.9.1", "x");
    expect(said).toContain("the install failed with rand_core 0.9.1, so it was put back");
    expect(said).toContain("failed to select a version");
    expect(readFileSync(join(h.repoDir, LOCK), "utf8")).toBe("rand 0.8.5\n");
    expect(existsSync(join(h.repoDir, "vendor.lock"))).toBe(false);
    expect(h.state.transactionFiles.has("vendor.lock")).toBe(false);
    expect(h.state.originals.has("vendor.lock")).toBe(false);
    expect(h.commands).toEqual([
      "after-install-request-1",
      "after-request-1-1",
      "after-install-request-1-undo",
    ]);
    expect(h.state.extraMoved).toEqual([]);
    expect(h.requester.lost()).toBeNull();
  });

  it("counts only upgrades that landed, and bounds the asks", async () => {
    const refused = harness([], { ok: false, reason: "the updater refused" });
    dirs.push(refused.repoDir);
    for (let i = 0; i < 4; i++)
      expect(await refused.requester.ask("x", "1", "y")).toContain("refused: the updater refused");
    expect(await refused.requester.ask("x", "1", "y")).toContain("already asked the updater 4 times");
    const landed = harness([0, 0], moved([{ path: LOCK, content: "rand_core 0.9.1\n" }]));
    dirs.push(landed.repoDir);
    await landed.requester.ask("a", "1", "y");
    await landed.requester.ask("b", "1", "y");
    expect(await landed.requester.ask("c", "1", "y")).toContain("already moved 2 other dependencies");
  });

  it("loses the environment when the install before it can't be restored, and refuses everything after", async () => {
    const h = harness([1, 1], moved([{ path: LOCK, content: "rand_core 0.9.1\n" }]));
    dirs.push(h.repoDir);
    expect(await h.requester.ask("rand_core", "0.9.1", "x")).toContain("Call finish; the run ends here");
    expect(h.requester.lost()).toContain("couldn't be restored (exit 1)");
    expect(await h.requester.ask("other", "1", "y")).toMatch(/^stopped: /);
    expect(h.asked).toHaveLength(1);
  });
});
