import { describe, expect, it } from "vitest";
import { PR_MODE_BY_EVIDENCE } from "../src/constants";
import {
  changeV2,
  dependencyInstance,
  dependencyKey,
  groupKey,
  lineageKey,
  PR_OPENING_KINDS,
} from "../src/contract";

describe("contract v2", () => {
  it("accepts a surface-diff record for a package major", () => {
    const record = changeV2.parse({
      schemaVersion: 2,
      id: "npm/openai/4.104.0..7.43.0/core.d.ts#ClientOptions.httpAgent",
      subject: { kind: "package", ecosystem: "npm", name: "openai" },
      kind: "symbol-removed",
      title: "ClientOptions.httpAgent removed",
      summary: "The httpAgent client option no longer exists.",
      applicability: { class: "breaks-on-upgrade", fromVersion: "4.104.0", toVersion: "7.43.0" },
      signatures: [
        {
          kind: "symbol",
          lang: "ts",
          declKey: "core.d.ts#ClientOptions.httpAgent",
          path: "ClientOptions.httpAgent",
          memberKind: "property",
        },
      ],
      sources: [
        {
          url: "https://registry.npmjs.org/openai/-/openai-7.43.0.tgz",
          kind: "surface-diff",
          trustBasis: "computed",
          contentHash: "a".repeat(64),
          checkedAt: "2026-10-24T12:00:00.000Z",
          tool: { name: "teire-dts-diff", version: "1" },
        },
      ],
      provenance: {
        method: "tool",
        tool: { name: "teire-dts-diff", version: "1", noiseFilterVersion: "1" },
        confidence: { overall: 1 },
      },
      visibility: "public",
      status: "confirmed",
    });
    expect(record.applicability.fixedIn).toEqual([]);
    expect(PR_OPENING_KINDS.has(record.kind)).toBe(true);
  });

  it("never guesses a version: unresolved instances carry null", () => {
    const instance = dependencyInstance.parse({
      ecosystem: "npm",
      name: "openai",
      version: null,
      direct: true,
      scope: "prod",
      workspace: ".",
      manifestPath: "package.json",
      source: "registry",
      resolvedBy: "unresolved",
      unresolvedReason: "no lockfile",
    });
    expect(instance.version).toBeNull();
    expect(dependencyKey(instance)).toBe("npm:openai@.");
    expect(groupKey("npm", "openai", "7.43.0")).toBe("npm/openai/7.43.0");
  });

  it("opens a ready PR only on verified evidence", () => {
    const ready = Object.entries(PR_MODE_BY_EVIDENCE)
      .filter(([, mode]) => mode === "ready")
      .map(([kind]) => kind);
    expect(ready).toEqual(["verified"]);
  });
});

describe("lineage keys", () => {
  it("drop the target from package groups and keep every other group whole", () => {
    expect(lineageKey("npm/zod/4.6.7")).toBe("npm/zod");
    expect(lineageKey("npm/@types/react/19.3.0")).toBe("npm/@types/react");
    expect(lineageKey("go/github.com/golang-jwt/jwt/v4/v5.3.1")).toBe("go/github.com/golang-jwt/jwt/v4");
    expect(lineageKey("maven/com.google.guava:guava/33.7.2-jre", "security")).toBe(
      "maven/com.google.guava:guava#security",
    );
    expect(lineageKey("models/openai")).toBe("models/openai");
    expect(lineageKey("advisory/npm/request/GHSA-p8p7-x288-28g6")).toBe(
      "advisory/npm/request/GHSA-p8p7-x288-28g6",
    );
  });
});
