import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenFactorySandboxes, underTimeout } from "../src/verify/tokenfactory";

// Review R24: each Token Factory command runs under GNU `timeout`, quoted for `sh -c`.
describe("underTimeout", () => {
  it("wraps the command so its quoting survives and a hang ends with 124", () => {
    const cmd = underTimeout(`cd /tmp && exec echo 'it'"'"'s fine'`, 5);
    expect(cmd.startsWith("timeout -k 10 5 sh -c ")).toBe(true);
    expect(execFileSync("sh", ["-c", cmd.replace(/^timeout -k 10 5 /, "")]).toString()).toBe("it's fine\n");
  });
});

// Review round 2: a quiet stream keeps one read pending, so the frame after the quiet spell is kept.
describe("follow", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the frame that arrives after an idle check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const encode = (frame: string) => new TextEncoder().encode(frame);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.includes("/events")) return Response.json({ uuid: "op", status: "EXECUTING" });
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(
              () => controller.enqueue(encode('id: 1\nevent: stdout\ndata: {"data":{"value":"hello"}}\n\n')),
              25_000,
            );
            setTimeout(() => controller.enqueue(encode("id: 2\nevent: completion\ndata: {}\n\n")), 26_000);
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }),
    );
    const logs: string[] = [];
    const client = new TokenFactorySandboxes({ apiKey: "k", project: "p" });
    const done = client.follow("op", 60_000, (chunk) => logs.push(chunk));
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(logs).toEqual(["hello"]);
  });
});
