import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CallSite, ChangeV2 } from "../src/contract";
import { applyCodemods } from "../src/fix/codemods";
import { importRewrite, keywordRemoval, planPythonEdits } from "../src/fix/python-edits";
import type { FindingDraft } from "../src/impact";
import { surfaceChangeRecords } from "../src/surface/records";
import type { SurfaceDiff } from "../src/surface/types";

const move = { from: "acme.legacy.Client", to: "acme.Client" };
const at = (source: string, needle: string) => {
  const before = source.slice(0, source.indexOf(needle));
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1) ?? "").length + 1 };
};

describe("Python imports rewritten where griffe finds the class moved (import-rewrite)", () => {
  it("rewrites the module, keeping an alias and the other names", () => {
    expect(importRewrite("from acme.legacy import Client\n", { line: 1 }, move)).toEqual({
      line: 1,
      before: "from acme.legacy import Client",
      after: "from acme import Client",
    });
    expect(
      importRewrite("    from acme.legacy import connect, Client as C  # noqa\n", { line: 1 }, move)?.after,
    ).toBe("    from acme.legacy import connect  # noqa\n    from acme import Client as C");
  });

  it("reads a parenthesised import over several lines", () => {
    const edit = importRewrite(
      "from acme.legacy import (\n    Client,\n    connect,\n)\nx = 1\n",
      { line: 1 },
      move,
    );
    expect(edit).toEqual({
      line: 1,
      endLine: 4,
      before: "from acme.legacy import (\n    Client,\n    connect,\n)",
      after: "from acme.legacy import connect\nfrom acme import Client",
    });
  });

  it("leaves a star import, another module and a relative import alone", () => {
    expect(importRewrite("from acme.legacy import *\n", { line: 1 }, move)).toBeNull();
    expect(importRewrite("from acme.other import Client\n", { line: 1 }, move)).toBeNull();
    expect(importRewrite("from .legacy import Client\n", { line: 1 }, move)).toBeNull();
  });
});

describe("a keyword the target no longer takes, removed from the call (kwarg-remove)", () => {
  const removal = (source: string, arg = "retries") => {
    const edit = keywordRemoval(source, at(source, "Client("), arg);
    if (!edit) return null;
    const lines = source.split("\n");
    lines.splice(edit.line - 1, (edit.endLine ?? edit.line) - edit.line + 1, edit.after);
    return lines.join("\n");
  };

  it("takes it out with its comma, wherever it sits", () => {
    expect(removal("c = Client(url, retries=3, timeout=5)\n")).toBe("c = Client(url, timeout=5)\n");
    expect(removal("c = Client(url, timeout=5, retries=3)\n")).toBe("c = Client(url, timeout=5)\n");
    expect(removal("c = Client(retries=3)\n")).toBe("c = Client()\n");
    expect(removal("c = Client(retries=3,)\n")).toBe("c = Client()\n");
    expect(removal('c = Client(url, retries=f("a,b)"), x=[1, 2])\n')).toBe("c = Client(url, x=[1, 2])\n");
  });

  it("spans a call over several lines, a trailing comma kept", () => {
    expect(removal("c = Client(\n    url,\n    retries=3,  # three\n    timeout=5,\n)\n")).toBe(
      "c = Client(\n    url,\n    timeout=5,\n)\n",
    );
    expect(removal("c = Client(\n    url,\n    retries=3,\n)\n")).toBe("c = Client(\n    url,\n)\n");
  });

  it("leaves a call that doesn't pass it, or passes it only nested, alone", () => {
    expect(removal("c = Client(url)\n")).toBeNull();
    expect(removal("c = Client(url, opts=dict(retries=3))\n")).toBeNull();
    expect(removal("c = Client(url, retries == 3)\n")).toBeNull();
  });
});

describe("planned from the target's surface, at type-resolved sites", () => {
  const dir = mkdtempSync(join(tmpdir(), "teire-pyedits-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const source = "from acme.legacy import Client\n\nc = Client(\n    url,\n    retries=3,\n)\n";
  writeFileSync(join(dir, "app.py"), source);
  const diff = {
    ecosystem: "pypi",
    name: "acme",
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    changes: [
      {
        path: "acme.legacy.Client",
        declKey: "acme.legacy.Client",
        kind: "removed",
        severity: "breaking",
        before: null,
        after: null,
        movedTo: "acme.Client",
      },
      {
        path: "acme.core.Session.__init__",
        declKey: "acme.core.Session.__init__",
        kind: "parameter-removed",
        severity: "breaking",
        before: "retries",
        after: null,
        param: "retries",
      },
    ],
    moved: {},
    notes: [],
    tool: { name: "griffe", version: "1", noiseFilterVersion: "1" },
  } as unknown as SurfaceDiff;
  const records = surfaceChangeRecords(diff, "2026-10-30T00:00:00.000Z");

  it("puts the edits the surface backs on the records, as the contract's codemod kinds", () => {
    const removed = records.find((r) => r.kind === "symbol-removed");
    expect(removed?.replacement?.codemod).toEqual({ kind: "import-rewrite", spec: { moves: [move] } });
    expect(removed?.summary).toContain("1 moved to a new import path");
    const params = records.find((r) => r.kind === "parameter-change");
    expect(params?.replacement?.codemod).toEqual({
      kind: "kwarg-remove",
      spec: { removed: [{ callee: "acme.core.Session.__init__", arg: "retries" }] },
    });
  });

  it("edits the import and the call, and nothing at a name-only site or a renamed keyword", () => {
    const site = (
      needle: string,
      kind: CallSite["kind"],
      declKey: string,
      resolution: CallSite["resolution"] = "type",
    ) => ({ file: "app.py", ...at(source, needle), kind, snippet: "", resolution, declKey }) as CallSite;
    const finding = (record: ChangeV2 | undefined, callSites: CallSite[]) =>
      ({ changeId: record?.id, callSites }) as unknown as FindingDraft;
    const findings = [
      finding(
        records.find((r) => r.kind === "symbol-removed"),
        [site("Client\n", "import", "acme.legacy.Client")],
      ),
      finding(
        records.find((r) => r.kind === "parameter-change"),
        [site("Client(", "call", "acme.core.Session.__init__")],
      ),
    ];
    const edits = planPythonEdits({ repoDir: dir, findings, records, notes: [] });
    expect(edits.map((e) => e.reason)).toEqual([
      "acme.legacy.Client → acme.Client",
      "`retries=` removed: __init__ no longer takes it",
    ]);
    applyCodemods(dir, edits);
    expect(readFileSync(join(dir, "app.py"), "utf8")).toBe(
      "from acme import Client\n\nc = Client(\n    url,\n)\n",
    );

    const loose = [
      finding(
        records.find((r) => r.kind === "parameter-change"),
        [site("Client(", "call", "acme.core.Session.__init__", "name-only")],
      ),
    ];
    expect(planPythonEdits({ repoDir: dir, findings: loose, records, notes: [] })).toEqual([]);
    const renamedNote = {
      text: "`retries` was renamed to `max_retries`",
      url: "https://x",
      quote: "`retries` was renamed to `max_retries`",
    };
    expect(
      planPythonEdits({ repoDir: dir, findings: findings.slice(1), records, notes: [renamedNote] as never }),
    ).toEqual([]);
  });
});
