import { describe, expect, it } from "vitest";
import { byteCap } from "../src/verify/backend";

// Review R17: a tarball streams to the sandbox through a byte cap instead of being held in memory.
const read = (chunks: number[], max: number) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const n of chunks) c.enqueue(new Uint8Array(n));
        c.close();
      },
    }).pipeThrough(byteCap(max)),
  ).arrayBuffer();

describe("byteCap", () => {
  it("passes a stream at or under the cap through whole", async () => {
    expect((await read([400, 600], 1000)).byteLength).toBe(1000);
  });

  it("fails the stream once it passes the cap, with the reason", async () => {
    await expect(read([600, 600], 1024 * 1024 - 1)).resolves.toBeDefined();
    await expect(read([700_000, 700_000], 1024 * 1024)).rejects.toThrow("over 1 MB");
  });
});
