import { describe, expect, it } from "vitest";
import { advisoriesFor } from "../src/advisories";
import { assess } from "../src/impact";

// Live: OSV and the GitHub Advisory Database, as the worker queries them.
describe("advisories for exact versions", () => {
  it("matches lodash 4.17.20, merges aliases and drops GitHub's withdrawn advisory", {
    timeout: 60_000,
  }, async () => {
    const matches = await advisoriesFor([
      { ecosystem: "npm", name: "lodash", version: "4.17.20" },
      { ecosystem: "npm", name: "left-pad", version: "1.3.0" },
    ]);
    const ids = matches.filter((m) => m.query.name === "lodash").map((m) => m.record.id.split("/").at(-1));
    expect(ids).toContain("GHSA-35jh-r3h4-6jhm");
    expect(ids).not.toContain("GHSA-8p5q-j9m2-g8wr"); // withdrawn 2021-10-01
    expect(new Set(ids).size).toBe(ids.length);
    expect(matches.some((m) => m.query.name === "left-pad")).toBe(false);

    const record = matches.find((m) => m.record.id.endsWith("GHSA-35jh-r3h4-6jhm"))?.record;
    expect(record?.applicability).toMatchObject({ class: "security", fixedIn: ["4.17.21"] });
    if (!record) return;
    const [finding] = assess({
      instance: {
        ecosystem: "npm",
        name: "lodash",
        version: "4.17.20",
        direct: false,
        scope: "prod",
        workspace: ".",
        manifestPath: "package-lock.json",
        source: "registry",
        resolvedBy: "lockfile",
      },
      target: "4.17.21",
      isMajor: false,
      records: [record],
      locate: null,
    });
    expect(finding).toMatchObject({ verdict: "affected", reachability: "package-present", priority: 0 });
  });
});
