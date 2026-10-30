import { describe, expect, it } from "vitest";
import { leadAfter, type ReadbackRoot, readbackMismatch } from "../src/fix/readback";

const at = (name: string, version: string | null, direct = true, markers?: string) => ({
  name,
  version,
  direct,
  ...(markers ? { environment: { markers } } : {}),
});
const root = (r: string, ...instances: ReadbackRoot["instances"]): ReadbackRoot => ({ root: r, instances });
const lead = { before: "reqwest", after: "reqwest" };

describe("chosen-version readback (S15.1)", () => {
  const moved = [
    { name: "reqwest", from: "0.11.27", to: "0.12.9" },
    { name: "http", from: "0.2.12", to: "1.2.0" },
  ];
  const before = [root(".", at("reqwest", "0.11.27"), at("http", "0.2.12", false))];

  it("passes when the committed files lock what the run says", () => {
    expect(
      readbackMismatch({
        before,
        after: [root(".", at("reqwest", "0.12.9"), at("http", "1.2.0", false))],
        lead,
        target: "0.12.9",
        moved,
      }),
    ).toBeNull();
  });

  it("names the lead locked elsewhere, and a moved package the files disagree on", () => {
    expect(
      readbackMismatch({
        before,
        after: [root(".", at("reqwest", "0.12.4"), at("http", "1.2.0", false))],
        lead,
        target: "0.12.9",
        moved,
      }),
    ).toContain("lock reqwest at 0.12.4 in the repository root, not 0.12.9");
    expect(
      readbackMismatch({
        before,
        after: [root(".", at("reqwest", "0.12.9"), at("http", "0.2.12", false))],
        lead,
        target: "0.12.9",
        moved,
      }),
    ).toContain("moved http to 1.2.0, but the files lock it at 0.2.12");
  });

  it("checks every root the run changed and every direct copy, not one that matches", () => {
    expect(
      readbackMismatch({
        before: [root("a", at("reqwest", "0.11.27")), root("b", at("reqwest", "0.11.27"))],
        after: [root("a", at("reqwest", "0.12.9")), root("b", at("reqwest", "0.12.4"))],
        lead,
        target: "0.12.9",
        moved: [],
      }),
    ).toContain("at 0.12.4 in b");
    expect(
      readbackMismatch({
        before: [root(".", at("reqwest", "0.11.27"), at("reqwest", "0.11.27"))],
        after: [root(".", at("reqwest", "0.12.9"), at("reqwest", "0.11.27"))],
        lead,
        target: "0.12.9",
        moved: [],
      }),
    ).toContain("at 0.12.9, 0.11.27");
    // A transitive copy another package needs may stay behind.
    expect(
      readbackMismatch({
        before: [root(".", at("reqwest", "0.11.27"))],
        after: [root(".", at("reqwest", "0.12.9"), at("reqwest", "0.11.27", false))],
        lead,
        target: "0.12.9",
        moved: [],
      }),
    ).toBeNull();
  });

  it("stops when a package the readers saw is gone or a root can't be read any more", () => {
    expect(readbackMismatch({ before, after: [root(".")], lead, target: "0.12.9", moved: [] })).toContain(
      "don't lock reqwest in the repository root any more",
    );
    expect(readbackMismatch({ before, after: [], lead, target: "0.12.9", moved: [] })).toContain(
      "can't after it",
    );
    expect(
      readbackMismatch({
        before,
        after: [root(".", at("reqwest", "0.12.9"))],
        lead,
        target: "0.12.9",
        moved,
      }),
    ).toContain("moved http to 1.2.0, but the files don't lock it any more");
  });

  it("takes a package the readers never saw as unknown, and keeps uv's marker forks", () => {
    expect(readbackMismatch({ before: [], after: [], lead, target: "0.12.9", moved })).toBeNull();
    expect(
      readbackMismatch({
        before: [root(".", at("x", "v1.1.0"))],
        after: [root(".", at("x", "v1.2.0"))],
        lead: { before: "x", after: "x" },
        target: "1.2.0",
        moved: [],
      }),
    ).toBeNull();
    expect(
      readbackMismatch({
        before: [
          root(
            ".",
            at("numpy", "1.24.4", true, "python_full_version < '3.9'"),
            at("numpy", "2.0.2", true, "python_full_version >= '3.9'"),
          ),
        ],
        after: [
          root(
            ".",
            at("numpy", "1.24.4", true, "python_full_version < '3.9'"),
            at("numpy", "2.2.1", true, "python_full_version >= '3.10'"),
          ),
        ],
        lead: { before: "numpy", after: "numpy" },
        target: "2.2.1",
        moved: [],
      }),
    ).toBeNull();
  });

  it("reads a Go major back at its new path, whatever the old path still locks", () => {
    const go = leadAfter("github.com/redis/go-redis", "github.com/redis/go-redis/v9 v9.7.0");
    expect(go).toEqual({ name: "github.com/redis/go-redis/v9", version: "v9.7.0" });
    expect(leadAfter("serde", "1.0.215")).toEqual({ name: "serde", version: "1.0.215" });
    const beforeGo = [root(".", at("github.com/redis/go-redis", "v8.11.5"))];
    expect(
      readbackMismatch({
        before: beforeGo,
        after: [
          root(
            ".",
            at("github.com/redis/go-redis/v9", "v9.7.0"),
            at("github.com/redis/go-redis", "v8.11.5", false),
          ),
        ],
        lead: { before: "github.com/redis/go-redis", after: go.name },
        target: go.version,
        moved: [],
      }),
    ).toBeNull();
    expect(
      readbackMismatch({
        before: beforeGo,
        after: [root(".", at("github.com/redis/go-redis", "v8.11.5", false))],
        lead: { before: "github.com/redis/go-redis", after: go.name },
        target: go.version,
        moved: [],
      }),
    ).toContain("don't lock github.com/redis/go-redis/v9");
  });
});
