import { describe, expect, it } from "vitest";
import type { DependencyInstance } from "../src/contract";
import { assess } from "../src/impact";
import type { LocateResult } from "../src/locate/ts";
import { surfaceChangeRecords } from "../src/surface/records";
import type { SurfaceDiff } from "../src/surface/types";

const instance = {
  ecosystem: "go",
  name: "github.com/acme/kit",
  version: "v1.4.0",
  direct: true,
  scope: "prod",
  workspace: ".",
  manifestPath: "go.mod",
  source: "registry",
  resolvedBy: "toolchain",
} as DependencyInstance;

const side = { ok: true } as unknown as SurfaceDiff["from"];
// `Dial(addr, timeout)` became `Dial(addr, timeout, opts)` with opts required: two arguments refused.
const diff = {
  ecosystem: "go",
  name: "github.com/acme/kit",
  fromVersion: "v1.4.0",
  toVersion: "v2.0.0",
  from: side,
  to: side,
  changes: [
    {
      path: "kit.Dial",
      declKey: "github.com/acme/kit.Dial",
      kind: "arity-changed",
      symbolKind: "function",
      severity: "breaking",
      before: "func(addr string, timeout time.Duration) (*Conn, error)",
      after: "func(addr string, timeout time.Duration, opts Options) (*Conn, error)",
      arity: { minBefore: 2, maxBefore: 2, minAfter: 3, maxAfter: 3 },
    },
  ],
  counts: { "arity-changed": 1 },
  moved: {},
  unanalyzable: false,
  tool: { name: "apidiff", version: "test" },
} as SurfaceDiff;

const hit = (line: number, argCount?: number) => ({
  file: "main.go",
  line,
  column: 5,
  kind: "call" as const,
  snippet: "kit.Dial(...)",
  resolution: "type" as const,
  declKey: "github.com/acme/kit.Dial",
  ...(argCount === undefined ? {} : { argCount }),
});

describe("arity changes break only the calls the new signature refuses (R21.8)", () => {
  const records = surfaceChangeRecords(diff);
  const located = (hits: ReturnType<typeof hit>[]) =>
    ({ hits, imports: [], coverage: null }) as unknown as LocateResult;

  it("flags a call with the old count and leaves one that already fits", () => {
    const findings = assess({
      instance,
      target: "v2.0.0",
      isMajor: true,
      records,
      locate: located([hit(10, 2), hit(20, 3)]),
    });
    const lines = findings.flatMap((f) => f.callSites.map((s) => s.line));
    expect(lines).toEqual([10]);
  });

  it("keeps a call whose count the locator couldn't read (a spread, a reference)", () => {
    const findings = assess({
      instance,
      target: "v2.0.0",
      isMajor: true,
      records,
      locate: located([hit(30)]),
    });
    expect(findings.flatMap((f) => f.callSites.map((s) => s.line))).toEqual([30]);
  });
});
