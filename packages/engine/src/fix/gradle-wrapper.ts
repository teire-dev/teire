import type { ManifestEdit } from "./upgrade-js";

/**
 * The Gradle wrapper raised when the upgrade needs a newer Gradle (S15.10, D-30). Plugins don't
 * publish the Gradle they need in their metadata (Spring Boot's doesn't); they refuse the build
 * instead, naming the version. That refusal is the floor: the wrapper's `distributionUrl` moves to
 * it, with Gradle's own published checksum when the repo pins one, and the step runs again once.
 */
const FLOOR = [
  // Spring Boot: "Spring Boot plugin requires Gradle 8.14 or later. The current version is Gradle 7.4"
  /requires Gradle (\d+\.\d+(?:\.\d+)?) or (?:later|newer)/i,
  // The Android Gradle Plugin: "Minimum supported Gradle version is 8.9. Current version is 8.0."
  /Minimum supported Gradle version is (\d+\.\d+(?:\.\d+)?)/i,
];

export const WRAPPER_PROPERTIES = "gradle/wrapper/gradle-wrapper.properties";
const DISTRIBUTIONS = "https://services.gradle.org/distributions";

/** The Gradle version a plugin's refusal names, if the output holds one. */
export function gradleFloorFrom(output: string): { version: string; quote: string } | null {
  for (const re of FLOOR) {
    const m = re.exec(output);
    if (m?.[1]) return { version: m[1], quote: m[0] };
  }
  return null;
}

const parts = (v: string) => v.split(".").map(Number);
function below(a: string, b: string) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/**
 * The wrapper properties with `distributionUrl` at `version`, or null when the wrapper is already
 * there or the file isn't the standard shape. A pinned `distributionSha256Sum` takes the new
 * distribution's checksum from Gradle's own `.sha256` file; without it the raise is refused, never
 * left unverified.
 */
export async function wrapperRaise(
  path: string,
  properties: string,
  floor: { version: string; quote: string },
  fetchText: (url: string) => Promise<string | null> = defaultFetch,
): Promise<ManifestEdit | null> {
  const url = /^distributionUrl=(.*gradle-)(\d+(?:\.\d+)*)(-(?:bin|all)\.zip)[ \t]*$/m.exec(properties);
  if (!url?.[2] || !below(url[2], floor.version)) return null;
  const kind = url[3] ?? "-bin.zip";
  let after = properties.replace(url[0], `distributionUrl=${url[1]}${floor.version}${kind}`);
  if (/^distributionSha256Sum=/m.test(properties)) {
    const sum = (await fetchText(`${DISTRIBUTIONS}/gradle-${floor.version}${kind}.sha256`))?.trim();
    if (!sum || !/^[0-9a-f]{64}$/.test(sum)) return null;
    after = after.replace(/^distributionSha256Sum=.*$/m, `distributionSha256Sum=${sum}`);
  }
  return {
    path,
    before: properties,
    after,
    from: `Gradle ${url[2]}`,
    to: `Gradle ${floor.version}`,
    note: `the Gradle wrapper moves from ${url[2]} to ${floor.version}: the build refused the old one ("${floor.quote}")`,
  };
}

async function defaultFetch(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  return res?.ok ? res.text() : null;
}
