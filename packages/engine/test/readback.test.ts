import { describe, expect, it } from "vitest";
import { readbackMismatch } from "../src/fix/readback";

const locked = (name: string, version: string) => ({ ecosystem: "cargo" as const, name, version });

describe("chosen-version readback (S15.1)", () => {
  const moved = [
    { name: "reqwest", from: "0.11.27", to: "0.12.9" },
    { name: "http", from: "0.2.12", to: "1.2.0" },
  ];

  it("passes when the committed files lock what the run says", () => {
    expect(
      readbackMismatch(
        [locked("reqwest", "0.12.9"), locked("http", "1.2.0")],
        "cargo",
        "reqwest",
        "0.12.9",
        moved,
      ),
    ).toBeNull();
  });

  it("names the lead locked elsewhere, and a moved package the files disagree on", () => {
    expect(
      readbackMismatch(
        [locked("reqwest", "0.12.4"), locked("http", "1.2.0")],
        "cargo",
        "reqwest",
        "0.12.9",
        moved,
      ),
    ).toContain("lock reqwest at 0.12.4, not 0.12.9");
    expect(
      readbackMismatch(
        [locked("reqwest", "0.12.9"), locked("http", "0.2.12")],
        "cargo",
        "reqwest",
        "0.12.9",
        moved,
      ),
    ).toContain("moved http to 1.2.0, but the files lock it at 0.2.12");
  });

  it("takes a package the readers don't see as unknown, not a mismatch; v prefixes are equal", () => {
    expect(readbackMismatch([], "cargo", "reqwest", "0.12.9", moved)).toBeNull();
    expect(
      readbackMismatch([{ ecosystem: "go", name: "x", version: "v1.2.0" }], "go", "x", "1.2.0", []),
    ).toBeNull();
  });
});
