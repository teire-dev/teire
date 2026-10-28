import { describe, expect, it } from "vitest";
import { gradleFloorFrom, wrapperRaise } from "../src/fix/gradle-wrapper";

// The wrapper raise (S15.10): the plugin's refusal names the Gradle it needs.
const properties = `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionSha256Sum=${"a".repeat(64)}
distributionUrl=https\\://services.gradle.org/distributions/gradle-7.4-bin.zip
zipStoreBase=GRADLE_USER_HOME
`;

describe("Gradle wrapper raise", () => {
  it("reads the floor from Spring Boot's and the Android plugin's refusals", () => {
    expect(
      gradleFloorFrom("> Spring Boot plugin requires Gradle 8.14 or later. The current version is Gradle 7.4")
        ?.version,
    ).toBe("8.14");
    expect(gradleFloorFrom("Minimum supported Gradle version is 8.9. Current version is 8.0.")?.version).toBe(
      "8.9",
    );
    expect(gradleFloorFrom("Could not resolve all files for configuration")).toBeNull();
  });

  it("moves distributionUrl and takes Gradle's published checksum", async () => {
    const floor = { version: "8.14", quote: "requires Gradle 8.14 or later" };
    const edit = await wrapperRaise(
      "gradle/wrapper/gradle-wrapper.properties",
      properties,
      floor,
      async (url) => (url.endsWith("gradle-8.14-bin.zip.sha256") ? "b".repeat(64) : null),
    );
    expect(edit?.after).toContain(
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip",
    );
    expect(edit?.after).toContain(`distributionSha256Sum=${"b".repeat(64)}`);
    expect(edit?.from).toBe("Gradle 7.4");
  });

  it("refuses without a checksum to pin, and never lowers the wrapper", async () => {
    const floor = { version: "8.14", quote: "" };
    expect(await wrapperRaise("p", properties, floor, async () => null)).toBeNull();
    expect(
      await wrapperRaise("p", properties, { version: "7.3", quote: "" }, async () => "c".repeat(64)),
    ).toBeNull();
  });
});
