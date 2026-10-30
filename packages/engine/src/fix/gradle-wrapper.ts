import { createHash } from "node:crypto";
import type { DependencyInstance } from "../contract";
import { GRADLE_WRAPPER } from "../inventory/jvm";
import type { RepoTree } from "../inventory/tree";
import { guardedFetch } from "../net/fetch";
import type { Transaction } from "./transaction";
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
  note?: string,
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
    note:
      note ??
      `the Gradle wrapper moves from ${url[2]} to ${floor.version}: the build refused the old one ("${floor.quote}")`,
  };
}

async function defaultFetch(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  return res?.ok ? res.text() : null;
}

const MAVEN_HOSTS = ["repo1.maven.org", "repo.maven.apache.org"];
/** apache-maven's binary distribution is about 10 MB. */
const MAX_MAVEN_ZIP = 64 * 1024 * 1024;

/**
 * The Maven wrapper's `distributionUrl` at `version` (S18.3). A pinned `distributionSha256Sum` gets
 * the new distribution's: Central publishes no sha256 for it, so the zip is downloaded, checked
 * against Central's own `.sha512`, then hashed; anything that doesn't check out refuses the edit.
 */
export async function mavenWrapperRaise(
  path: string,
  properties: string,
  version: string,
): Promise<ManifestEdit | null> {
  const url =
    /^distributionUrl=(.*\/apache-maven\/)([^/\s]+)(\/apache-maven-)([^/\s]+?)(-bin\.zip|-bin\.tar\.gz)[ \t]*$/m.exec(
      properties,
    );
  if (!url?.[2] || url[2] === version) return null;
  const next = `${url[1]}${version}${url[3]}${version}${url[5]}`;
  let after = properties.replace(url[0], `distributionUrl=${next}`);
  if (/^distributionSha256Sum=/m.test(properties)) {
    const zipUrl = next.replace(/\\:/g, ":");
    const host = new URL(zipUrl).hostname;
    if (!MAVEN_HOSTS.includes(host)) return null;
    const [zip, sha512] = await Promise.all([
      guardedFetch(zipUrl, { allowHosts: MAVEN_HOSTS, maxBytes: MAX_MAVEN_ZIP, timeoutMs: 120_000 }),
      guardedFetch(`${zipUrl}.sha512`, { allowHosts: MAVEN_HOSTS }),
    ]);
    const published = sha512.status === 200 ? /^[0-9a-f]{128}/.exec(sha512.text().trim())?.[0] : null;
    if (zip.status !== 200 || !published) return null;
    if (createHash("sha512").update(zip.body).digest("hex") !== published) return null;
    after = after.replace(
      /^distributionSha256Sum=.*$/m,
      `distributionSha256Sum=${createHash("sha256").update(zip.body).digest("hex")}`,
    );
  }
  return {
    path,
    before: properties,
    after,
    from: `Maven ${url[2]}`,
    to: `Maven ${version}`,
    note: `the Maven wrapper moves from ${url[2]} to ${version}`,
  };
}

/**
 * The build tool's own upgrade as a candidate (D-30, S18.3): the Gradle or Maven wrapper's
 * properties, with its checksum when the repo pins one. The sandbox build is the check.
 */
export async function wrapperTransaction(
  tree: RepoTree,
  instance: DependencyInstance,
  target: string,
  fetchText: (url: string) => Promise<string | null> = defaultFetch,
): Promise<Transaction | null> {
  if (instance.role !== "wrapper") return null;
  const path = instance.manifestPath;
  const before = tree.read(path);
  if (before === null) return null;
  const edit =
    instance.name === GRADLE_WRAPPER
      ? await wrapperRaise(
          path,
          before,
          { version: target, quote: "" },
          fetchText,
          `the Gradle wrapper moves from ${instance.version} to ${target}`,
        )
      : await mavenWrapperRaise(path, before, target);
  // A wrapper that can't be moved is said so, never handed to the library editors.
  if (!edit)
    return {
      describe: `${path}: the wrapper can't move to ${target}`,
      manifest: [],
      commands: [],
      readBack: [path],
      check: () =>
        /^distributionSha256Sum=/m.test(before)
          ? `${path} pins a checksum Teire could not verify for ${target}`
          : `${path} has no standard distributionUrl to move to ${target}`,
    };
  return {
    describe: `${path}: ${edit.from} → ${edit.to}`,
    manifest: [edit],
    commands: [],
    readBack: [path],
    check: (files) => ((files[path] ?? "").includes(target) ? null : `${path} does not name ${target}`),
  };
}
