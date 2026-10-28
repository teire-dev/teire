import { describe, expect, it } from "vitest";
import { forGitHub } from "../src/github/redact";

// Review R18: errors reach GitHub without service bodies, ids, tokens or the worker's paths.
describe("forGitHub", () => {
  it("drops a service's response body and its project id", () => {
    expect(
      forGitHub(
        'Token Factory Sandboxes POST /files → 403: {"detail":"project aiproject-e00abc123 has no spawn"}',
      ),
    ).toBe("Token Factory Sandboxes POST /files → 403");
    expect(forGitHub("spawn failed in aiproject-e00abc123")).toBe("spawn failed in <project>");
  });

  it("replaces tokens, credentials in URLs, sandbox ids and the worker's paths", () => {
    const out = forGitHub(
      "git clone https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r failed at /tmp/teire-run-1/repo/src/a.ts; operation 0b6a2f1e-1234-4abc-9def-0123456789ab lost; Bearer abcdefghijklmnop",
    );
    expect(out).not.toMatch(/ghs_|abcdefghijklmnop|0b6a2f1e|\/tmp\//);
    expect(out).toContain("https://***@github.com/o/r");
    expect(out).toContain("<path>");
    expect(out).toContain("operation <id> lost");
  });

  it("keeps repository paths and shortens long text", () => {
    expect(forGitHub("tsc: src/index.ts(3,1): error TS2304")).toBe("tsc: src/index.ts(3,1): error TS2304");
    expect(forGitHub("x".repeat(500))).toHaveLength(300);
  });

  it("hides credentials in query strings and name=value pairs, and keeps run links and URLs", () => {
    const out = forGitHub(
      "GET https://api.example.com/v1/x?api_key=abc123secret&page=2 failed; password=hunter2 secret: s3cr3tvalue nvapi-ABCDEFGHIJKLMNOPQRSTUV",
    );
    expect(out).not.toMatch(/abc123secret|hunter2|s3cr3tvalue|nvapi-ABCD/);
    expect(out).toContain("page=2");
    expect(
      forGitHub(
        "see https://teire.vercel.app/runs/0b6a2f1e-1234-4abc-9def-0123456789ab and https://x.dev/app/docs",
      ),
    ).toBe(
      "see https://teire.vercel.app/runs/0b6a2f1e-1234-4abc-9def-0123456789ab and https://x.dev/app/docs",
    );
  });

  it("cuts a response body to the end of its line, keeping a later cause", () => {
    expect(forGitHub('POST /files → 500: {"detail":"boom"}\nthen the retry timed out')).toBe(
      "POST /files → 500 then the retry timed out",
    );
  });
});
