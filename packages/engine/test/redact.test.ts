import { describe, expect, it } from "vitest";
import { forGitHub, maskSecrets } from "../src/github/redact";

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

  it("hides values under any credential-named key, in either form (review round 2)", () => {
    const out = forGitHub(
      "registry said authorization=s3cr3tvalue; GITHUB_TOKEN=abc123def; x-api-key: k9k9k9; Authorization: Basic dXNlcjpwYXNzd29yZA==; NPM_AUTH_TOKEN='zzz'",
    );
    expect(out).not.toMatch(/s3cr3tvalue|abc123def|k9k9k9|dXNlcjpwYXNz|zzz/);
    expect(out).toContain("authorization=***");
    expect(out).toContain("GITHUB_TOKEN=***");
  });
});

describe("maskSecrets (run page output)", () => {
  it("masks credentials and keeps the output's lines", () => {
    const out = [
      "PASS src/a.test.ts",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123",
      "fetching https://user:hunter2@registry.example.com/pkg",
      "AWS key AKIAABCDEFGHIJKLMNOP in env",
      "Authorization: Bearer abcdefghijklmnop",
      "  3 passed",
    ].join("\n");
    const masked = maskSecrets(out);
    expect(masked.split("\n")).toHaveLength(6);
    expect(masked).not.toMatch(/ghp_|hunter2|AKIAABCD|abcdefghijklmnop/);
    expect(masked).toContain("PASS src/a.test.ts");
    expect(masked).toContain("  3 passed");
  });

  it("keeps a source file's line, which is proof, and still masks a credential with a file-like name", () => {
    const out = maskSecrets(
      "- [`go-major/auth/token.go:12`] jwt.StandardClaims\nsrc/auth.ts:40-42 and lib/session_id.rb:7:3\nAUTH_TOKEN: abc123secretvalue\ntoken.json: 9f8e7d6c5b4a\nsession_id: 123456",
    );
    expect(out).toContain("go-major/auth/token.go:12`");
    expect(out).toContain("src/auth.ts:40-42");
    expect(out).toContain("lib/session_id.rb:7:3");
    expect(out).toContain("AUTH_TOKEN: ***");
    expect(out).toContain("token.json: ***");
    expect(out).toContain("session_id: ***");
  });
});
