import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectationSwaps } from "../src/pipeline/api";

// Live walk, teire-dev/bristow: the code's default model moved, its spec's expectation did not.
const repo = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "teire-exp-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};
const swap = (file: string, line: number) => ({
  file,
  line,
  before: "",
  after: "",
  reason: "model swap claude-3-5-sonnet-20241022 → claude-sonnet-5-5",
  noteUrl: "https://docs.anthropic.com",
});

describe("expectationSwaps", () => {
  it("moves the paired spec's equality assertion with the code's swap, and leaves mentions alone", () => {
    const dir = repo({
      "lib/bristow/providers/anthropic.rb": 'def default_model\n  "claude-3-5-sonnet-20241022"\nend\n',
      "spec/bristow/providers/anthropic_spec.rb": [
        'it "returns claude-3-5-sonnet-20241022" do',
        '  expect(provider.default_model).to eq("claude-3-5-sonnet-20241022")',
        "end",
        'RETIRED = ["claude-3-5-sonnet-20241022"]',
      ].join("\n"),
      "spec/other_spec.rb": 'expect(x).to eq("claude-3-5-sonnet-20241022")\n',
    });
    const edits = expectationSwaps(dir, [swap("lib/bristow/providers/anthropic.rb", 2)]);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      file: "spec/bristow/providers/anthropic_spec.rb",
      line: 2,
      after: '  expect(provider.default_model).to eq("claude-sonnet-5-5")',
      reason: "model swap claude-3-5-sonnet-20241022 → claude-sonnet-5-5 (a test's expected value)",
    });
  });

  it("reads Go, Java, Python and JS assertions", () => {
    const dir = repo({
      "provider.go": 'return "claude-3-5-sonnet-20241022"\n',
      "provider_test.go":
        'assert.Equal(t, "claude-3-5-sonnet-20241022", got)\nif got != "claude-3-5-sonnet-20241022" {\n',
      "src/test/ProviderTest.java": 'assertEquals("claude-3-5-sonnet-20241022", p.model());\n',
      "Provider.java": 'return "claude-3-5-sonnet-20241022";\n',
      "tests/test_provider.py": 'assert provider.model == "claude-3-5-sonnet-20241022"\n',
      "provider.py": 'MODEL = "claude-3-5-sonnet-20241022"\n',
    });
    const edits = expectationSwaps(dir, [
      swap("provider.go", 1),
      swap("Provider.java", 1),
      swap("provider.py", 1),
    ]);
    expect(edits.map((e) => `${e.file}:${e.line}`).sort()).toEqual([
      "provider_test.go:1",
      "provider_test.go:2",
      "src/test/ProviderTest.java:1",
      "tests/test_provider.py:1",
    ]);
  });
});
