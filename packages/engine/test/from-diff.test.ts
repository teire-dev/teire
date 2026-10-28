import { createTwoFilesPatch } from "diff";
import { describe, expect, it } from "vitest";
import { filesFromDiff } from "../src/fix/from-diff";

const patch = (path: string, before: string, after: string | null) =>
  createTwoFilesPatch(`a/${path}`, after === null ? "/dev/null" : `b/${path}`, before, after ?? "", "", "", {
    context: 3,
  });

describe("filesFromDiff (Open draft anyway)", () => {
  const base: Record<string, string> = { "src/a.ts": "one\ntwo\nthree\n", "old.txt": "bye\n" };
  const read = (p: string) => base[p] ?? null;

  it("rebuilds edits, new files and deletions from a run's stored diff", () => {
    const diff = [
      patch("src/a.ts", base["src/a.ts"] as string, "one\n2\nthree\nfour\n"),
      patch("new.txt", "", "hello\n"),
      patch("old.txt", "bye\n", null),
    ].join("\n");
    expect(filesFromDiff(diff, read)).toEqual({
      files: [
        { path: "src/a.ts", content: "one\n2\nthree\nfour\n" },
        { path: "new.txt", content: "hello\n" },
        { path: "old.txt", content: null },
      ],
    });
  });

  it("refuses a diff that no longer applies, a binary file and a path outside the repository", () => {
    expect(filesFromDiff(patch("src/a.ts", "other\n", "x\n"), read)).toEqual({
      error: "the run's diff no longer applies to `src/a.ts`",
    });
    expect(filesFromDiff("Binary files a/bun.lockb and b/bun.lockb differ\n", read)).toMatchObject({
      error: expect.stringContaining("bun.lockb"),
    });
    expect(filesFromDiff(patch("../etc/passwd", "", "x\n"), read)).toMatchObject({
      error: expect.stringContaining("outside the repository"),
    });
  });
});
