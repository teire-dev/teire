import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { XMLParser } from "fast-xml-parser";
import { JVM, SURFACE } from "../constants";
import { guardedFetch } from "../net/fetch";
import type { SurfaceChange, SurfaceDiff } from "./types";

const run = promisify(execFile);

/**
 * JVM API-surface diff (plan S08, research jvm.md Job 4): japicmp compares the two published jars'
 * bytecode (no library code runs; a JRE in the worker). Kotlin Multiplatform artifacts publish the
 * classes under a `-jvm` variant named in the `.module` file. japicmp's XML becomes surface changes
 * keyed `pkg.Class`, `pkg.Class#member` and `pkg.Class#<init>`; a removed overload whose name
 * survives is an arity change listing what remains. Kotlin `internal` members (mangled
 * `name$module`) and synthetic accessors are dropped: no consumer can call them.
 */
export function javaBinary() {
  return process.env.TEIRE_JAVA ?? "java";
}

/** The japicmp jar: baked into the worker image, else fetched once into the user cache (SHA-1 checked). */
export async function japicmpJar() {
  if (process.env.TEIRE_JAPICMP_JAR) return process.env.TEIRE_JAPICMP_JAR;
  const dir = join(homedir(), ".cache", "teire");
  const path = join(dir, `japicmp-${JVM.japicmpVersion}.jar`);
  if (existsSync(path)) return path;
  const res = await guardedFetch(JVM.japicmpUrl, {
    allowHosts: ["repo1.maven.org"],
    maxBytes: 32 * 1024 * 1024,
    timeoutMs: 120_000,
  });
  if (res.status !== 200) throw new Error(`japicmp download ${res.status}`);
  if (createHash("sha1").update(res.body).digest("hex") !== JVM.japicmpSha1)
    throw new Error("japicmp SHA-1 mismatch");
  await mkdir(dir, { recursive: true });
  await writeFile(`${path}.tmp`, res.body);
  await rename(`${path}.tmp`, path);
  return path;
}

const mavenPath = (name: string) => {
  const [g, a] = name.split(":") as [string, string];
  return `${g.replace(/\./g, "/")}/${a}`;
};

async function fetchArtifact(path: string, maxBytes = JVM.maxJarBytes) {
  for (const base of JVM.mavenMirrors) {
    const host = new URL(base).hostname;
    const res = await guardedFetch(`${base}/${path}`, {
      allowHosts: [host],
      maxBytes,
      timeoutMs: 120_000,
    }).catch(() => null);
    if (res?.status === 200) return { body: res.body, base, host };
    if (res?.status === 404) return null;
  }
  return null;
}

/** The jar holding a version's classes: the artifact itself, or the `-jvm` variant a KMP `.module` names. */
async function jarOf(name: string, version: string) {
  const [, artifact] = name.split(":") as [string, string];
  const dir = `${mavenPath(name)}/${version}`;
  let jarArtifact = artifact;
  const module = await fetchArtifact(`${dir}/${artifact}-${version}.module`, 4 * 1024 * 1024);
  if (module) {
    try {
      const doc = JSON.parse(Buffer.from(module.body).toString("utf8")) as {
        variants?: {
          name?: string;
          attributes?: Record<string, string>;
          "available-at"?: { module?: string };
        }[];
      };
      const jvm = doc.variants?.find(
        (v) =>
          v.attributes?.["org.jetbrains.kotlin.platform.type"] === "jvm" &&
          v.attributes?.["org.gradle.usage"] === "java-api" &&
          v["available-at"]?.module,
      );
      if (jvm?.["available-at"]?.module) jarArtifact = jvm["available-at"].module;
    } catch {
      // Not Gradle module metadata Teire can read: the plain jar.
    }
  }
  const [group] = name.split(":") as [string];
  const path = `${group.replace(/\./g, "/")}/${jarArtifact}/${version}/${jarArtifact}-${version}.jar`;
  const jar = await fetchArtifact(path);
  if (!jar) throw new Error(`no jar for ${name}:${version} (${jarArtifact})`);
  const sha1 = await fetchArtifact(`${path}.sha1`, 1024);
  const expected = (sha1 ? Buffer.from(sha1.body).toString("utf8") : "").trim().split(/\s+/)[0];
  if (expected && createHash("sha1").update(jar.body).digest("hex") !== expected)
    throw new Error(`SHA-1 mismatch for ${jarArtifact}-${version}.jar`);
  return { body: jar.body, artifact: jarArtifact };
}

type X = Record<string, unknown>;
const list = (v: unknown): X[] =>
  v === undefined || v === "" ? [] : Array.isArray(v) ? (v as X[]) : [v as X];
const ENTITIES: Record<string, string> = {
  "&apos;": "'",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
};
const attr = (o: X, k: string) =>
  ((o[`@_${k}`] as string | undefined) ?? "").replace(/&(?:apos|quot|lt|gt|amp);/g, (e) => ENTITIES[e] ?? e);

/** Java names for display: `com.google.common.base.Objects$ToStringHelper` → `…Objects.ToStringHelper`. */
const display = (cls: string) => cls.replace(/\$/g, ".");
const INTERNAL_MEMBER = /\$[\w]+$|^access\$|^-|\$\$/;

function changeTypes(o: X) {
  return list((o.compatibilityChanges as X | undefined)?.compatibilityChange).map((c) => attr(c, "type"));
}

function params(m: X) {
  return list((m.parameters as X | undefined)?.parameter).map((p) =>
    attr(p, "type").replace(/^java\.lang\./, ""),
  );
}

/** `kotlin.Deprecated` on a member: its level, message and `replaceWith` expression. */
function kotlinDeprecation(m: X) {
  const ann = list((m.annotations as X | undefined)?.annotation).find(
    (a) => attr(a, "fullyQualifiedName") === "kotlin.Deprecated" && attr(a, "changeStatus") !== "REMOVED",
  );
  if (!ann) return null;
  const elements = list((ann.elements as X | undefined)?.element);
  const value = (name: string) =>
    list(
      (elements.find((e) => attr(e, "name") === name)?.newElementValues as X | undefined)?.newElementValue,
    )[0];
  const parts = list((value("replaceWith")?.values as X | undefined)?.value);
  const replace = parts.find((v) => attr(v, "name") === "expression");
  // Extension functions need their import (`okhttp3.HttpUrl.Companion.toHttpUrlOrNull`).
  const imports = list((parts.find((v) => attr(v, "name") === "imports")?.values as X | undefined)?.value)
    .map((v) => attr(v, "value"))
    .filter((v) => v && v !== "n.a.");
  return {
    // Kotlin's default level is WARNING.
    level: value("level") ? attr(value("level") as X, "value") : "WARNING",
    message: value("message") ? attr(value("message") as X, "value") : "",
    replaceWith: replace ? attr(replace, "value") : "",
    imports,
    isNew:
      attr(ann, "changeStatus") === "NEW" ||
      elements.some((e) => attr(e, "name") === "level" && attr(e, "changeStatus") !== "UNCHANGED"),
  };
}

/** Callable from outside its package in the new version (public or protected). */
const accessible = (m: X) =>
  list((m.modifiers as X | undefined)?.modifier).some((x) =>
    ["PUBLIC", "PROTECTED"].includes(attr(x, "newValue")),
  );

const incompatible = (o: X) =>
  attr(o, "binaryCompatible") === "false" || attr(o, "sourceCompatible") === "false";

/**
 * Parses japicmp's XML report (`-m`: every member of each modified class, so surviving overloads
 * are visible) into surface changes. Members that gained `kotlin.Deprecated(level = ERROR|HIDDEN)`
 * stop compiling for Kotlin callers only, although Java bytecode still links (japicmp calls them
 * compatible): they get `kotlin:` keys, which only Kotlin files match, and their `replaceWith`.
 */
function parseXml(xmlText: string) {
  // The parser refuses a `constructor` tag (prototype pollution guard): rename japicmp's.
  const text = xmlText.replace(/<(\/?)constructor(s?)\b/g, "<$1ctor$2");
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (n) =>
      [
        "class",
        "method",
        "ctor",
        "field",
        "parameter",
        "compatibilityChange",
        "annotation",
        "element",
        "newElementValue",
        "value",
      ].includes(n),
  }).parse(text) as X;
}

const classesOf = (doc: X) => list(((doc.japicmp as X)?.classes as X | undefined)?.class);

/** Classes of a `-m` report that lost a method or constructor: the second pass lists all their members. */
export function classesLosingMembers(xmlText: string) {
  return classesOf(parseXml(xmlText))
    .filter(
      (c) =>
        attr(c, "changeStatus") === "MODIFIED" &&
        [...list((c.methods as X | undefined)?.method), ...list((c.ctors as X | undefined)?.ctor)].some(
          (m) => attr(m, "changeStatus") === "REMOVED",
        ),
    )
    .map((c) => attr(c, "fullyQualifiedName"));
}

/** Method names a report shows alive in the new version (any class). */
export function liveMethodNames(xmlText: string) {
  const names = new Set<string>();
  for (const c of classesOf(parseXml(xmlText)))
    for (const m of list((c.methods as X | undefined)?.method))
      if (attr(m, "changeStatus") !== "REMOVED") names.add(attr(m, "name").replace(/^-deprecated_/, ""));
  return names;
}

/** Every surviving method (`Class#name` → parameter lists) of a full report on selected classes. */
export function memberIndex(xmlText: string) {
  const index = new Map<string, string[][]>();
  for (const c of classesOf(parseXml(xmlText)))
    for (const m of list((c.methods as X | undefined)?.method))
      if (attr(m, "changeStatus") !== "REMOVED" && accessible(m)) {
        const key = `${attr(c, "fullyQualifiedName")}#${attr(m, "name")}`;
        index.set(key, [...(index.get(key) ?? []), params(m)]);
      }
  return index;
}

export function parseJapicmp(xmlText: string, members: Map<string, string[][]> = new Map()): SurfaceChange[] {
  const classes = classesOf(parseXml(xmlText));
  // Where a removed member's name still lives (`Objects.toStringHelper` → `MoreObjects`).
  const liveNames = new Map<string, Set<string>>();
  for (const c of classes)
    for (const m of list((c.methods as X | undefined)?.method))
      if (attr(m, "changeStatus") !== "REMOVED") {
        const name = attr(m, "name");
        liveNames.set(name, (liveNames.get(name) ?? new Set()).add(display(attr(c, "fullyQualifiedName"))));
      }
  const out: SurfaceChange[] = [];
  for (const c of classes) {
    const cls = attr(c, "fullyQualifiedName");
    if (!cls || /\$\d+$/.test(cls)) continue;
    const status = attr(c, "changeStatus");
    // A new class matters only for its Kotlin errors (a Kotlin companion replacing Java statics).
    if (status === "NEW" && !/\$Companion$/.test(cls)) continue;
    // Kotlin calls a companion's members on the class itself (`HttpUrl.parse`).
    const owner = cls.replace(/\$Companion$/, "");
    if (status === "REMOVED") {
      out.push({
        path: display(cls),
        declKey: cls,
        kind: "removed",
        symbolKind: "class",
        severity: "breaking",
        before: display(cls),
        after: null,
      });
      continue;
    }
    const classChanges = changeTypes(c).filter((t) =>
      /CLASS_NOW_(ABSTRACT|FINAL)|SUPERCLASS_REMOVED|INTERFACE_REMOVED|CLASS_TYPE_CHANGED|CLASS_LESS_ACCESSIBLE/.test(
        t,
      ),
    );
    if (classChanges.length && incompatible(c))
      out.push({
        path: display(cls),
        declKey: cls,
        kind: "signature-changed",
        symbolKind: "class",
        severity: "breaking",
        before: null,
        after: null,
        guidance: classChanges.join(", ").toLowerCase().replace(/_/g, " "),
      });

    const methods = list((c.methods as X | undefined)?.method);
    const remaining = (name: string) => {
      const listed = methods
        .filter((m) => attr(m, "name") === name && attr(m, "changeStatus") !== "REMOVED" && accessible(m))
        .map(params);
      const full = members.get(`${cls}#${name}`) ?? [];
      return [...new Map([...listed, ...full].map((p) => [p.join(","), p])).values()];
    };
    for (const m of methods) {
      const name = attr(m, "name");
      const types = changeTypes(m);
      const kt = kotlinDeprecation(m);
      // `-deprecated_body` is how Kotlin keeps `body()` for Java while Kotlin callers get the error.
      if (kt?.isNew && attr(m, "changeStatus") !== "REMOVED") {
        const source = name.replace(/^-deprecated_/, "");
        if (!INTERNAL_MEMBER.test(source)) {
          const path = `${display(owner)}.${source}(${params(m).join(", ")})`;
          const advice = `${kt.message}${kt.replaceWith ? `; replace with \`${kt.replaceWith}\`` : ""}${kt.imports.length ? ` (import ${kt.imports.map((i) => `\`${i}\``).join(", ")})` : ""}`;
          out.push(
            kt.level === "WARNING"
              ? {
                  path,
                  declKey: `${owner}#${source}`,
                  kind: "deprecated",
                  symbolKind: "method",
                  severity: "deprecation",
                  before: path,
                  after: null,
                  newlyDeprecated: true,
                  guidance: advice,
                }
              : {
                  path,
                  declKey: `kotlin:${owner}#${source}`,
                  kind: "removed",
                  symbolKind: "method",
                  severity: "breaking",
                  before: path,
                  after: kt.replaceWith || null,
                  guidance: `Kotlin callers: ${advice} (Java bytecode still links)`,
                },
          );
        }
        continue;
      }
      if (!name || INTERNAL_MEMBER.test(name) || status === "NEW") continue;
      const sig = `${display(owner)}.${name}(${params(m).join(", ")})`;
      const key = `${owner}#${name}`;
      if (
        attr(m, "changeStatus") === "REMOVED" ||
        types.includes("METHOD_REMOVED") ||
        types.includes("METHOD_LESS_ACCESSIBLE")
      ) {
        const left = remaining(name);
        const elsewhere = [...(liveNames.get(name) ?? [])].filter((x) => x !== display(cls)).slice(0, 3);
        const hint = elsewhere.length ? `; \`${name}\` now on ${elsewhere.join(", ")}` : "";
        if (left.length) {
          const counts = left.map((p) => p.length);
          out.push({
            path: sig,
            declKey: key,
            kind: "arity-changed",
            symbolKind: "method",
            severity: "breaking",
            before: sig,
            after: left.map((p) => `${name}(${p.join(", ")})`).join(" | "),
            arity: {
              minBefore: params(m).length,
              maxBefore: params(m).length,
              minAfter: Math.min(...counts),
              maxAfter: Math.max(...counts),
            },
            guidance: `overload removed; remaining: ${left.map((p) => `${name}(${p.join(", ")})`).join(", ")}${hint}`,
          });
        } else
          out.push({
            path: sig,
            declKey: key,
            kind: "removed",
            symbolKind: "method",
            severity: "breaking",
            before: sig,
            after: null,
            ...(hint ? { guidance: hint.slice(2) } : {}),
          });
        continue;
      }
      if (!incompatible(m)) {
        if (types.includes("ANNOTATION_DEPRECATED_ADDED"))
          out.push({
            path: sig,
            declKey: key,
            kind: "deprecated",
            symbolKind: "method",
            severity: "deprecation",
            before: sig,
            after: null,
            newlyDeprecated: true,
          });
        continue;
      }
      const other = types.filter((t) =>
        /METHOD_RETURN_TYPE_CHANGED|METHOD_NOW_STATIC|METHOD_NO_LONGER_STATIC|METHOD_NOW_ABSTRACT|METHOD_NOW_THROWS_CHECKED_EXCEPTION|METHOD_ABSTRACT_ADDED|METHOD_ADDED_TO_INTERFACE|METHOD_NOW_FINAL/.test(
          t,
        ),
      );
      if (other.length)
        out.push({
          path: sig,
          declKey: key,
          kind: "signature-changed",
          symbolKind: "method",
          // `final`/new abstract methods break subclasses and implementations, not callers.
          severity: other.every((t) => /NOW_FINAL|ADDED_TO_INTERFACE|ABSTRACT_ADDED|NOW_ABSTRACT/.test(t))
            ? "drift"
            : "breaking",
          before: sig,
          after: null,
          guidance: other.join(", ").toLowerCase().replace(/_/g, " "),
        });
    }
    const ctors = list((c.ctors as X | undefined)?.ctor);
    for (const k of ctors) {
      if (!changeTypes(k).some((t) => t === "CONSTRUCTOR_REMOVED" || t === "CONSTRUCTOR_LESS_ACCESSIBLE"))
        continue;
      const left = ctors.filter((x) => attr(x, "changeStatus") !== "REMOVED" && accessible(x)).map(params);
      const sig = `new ${display(cls)}(${params(k).join(", ")})`;
      out.push({
        path: sig,
        declKey: `${cls}#<init>`,
        kind: left.length ? "arity-changed" : "removed",
        symbolKind: "method",
        severity: "breaking",
        before: sig,
        after: left.length ? left.map((p) => `(${p.join(", ")})`).join(" | ") : null,
        ...(left.length
          ? {
              guidance: `constructor overload removed; remaining: ${left.map((p) => `(${p.join(", ")})`).join(", ")}`,
            }
          : {}),
      });
    }
    for (const f of list((c.fields as X | undefined)?.field)) {
      const name = attr(f, "name");
      if (!name || INTERNAL_MEMBER.test(name)) continue;
      const types = changeTypes(f);
      const path = `${display(owner)}.${name}`;
      if (
        attr(f, "changeStatus") === "REMOVED" ||
        types.includes("FIELD_REMOVED") ||
        types.includes("FIELD_LESS_ACCESSIBLE")
      )
        out.push({
          path,
          declKey: `${owner}#${name}`,
          kind: "removed",
          symbolKind: "property",
          severity: "breaking",
          before: path,
          after: null,
        });
      else if (
        incompatible(f) &&
        types.some((t) =>
          /FIELD_TYPE_CHANGED|FIELD_NOW_STATIC|FIELD_NO_LONGER_STATIC|FIELD_NOW_FINAL/.test(t),
        )
      )
        out.push({
          path,
          declKey: `${owner}#${name}`,
          kind: "signature-changed",
          symbolKind: "property",
          severity: "breaking",
          before: path,
          after: null,
          guidance: types.join(", ").toLowerCase().replace(/_/g, " "),
        });
    }
  }
  return out;
}

export async function jvmSurfaceDiff(name: string, from: string, to: string): Promise<SurfaceDiff> {
  const started = Date.now();
  const notes: string[] = [];
  let changes: SurfaceChange[] = [];
  let unanalyzable = false;
  let kept: string[] = [];
  const scratch = await mkdtemp(join(tmpdir(), "teire-jar-"));
  try {
    const [a, b] = await Promise.all([jarOf(name, from), jarOf(name, to)]);
    await writeFile(join(scratch, "old.jar"), a.body);
    await writeFile(join(scratch, "new.jar"), b.body);
    const base = [
      "-jar",
      await japicmpJar(),
      "-o",
      join(scratch, "old.jar"),
      "-n",
      join(scratch, "new.jar"),
      // Optional dependencies are never all present: their absence must not abort the diff.
      "--ignore-missing-classes",
    ];
    const java = (args: string[]) =>
      run(javaBinary(), [...base, ...args], { timeout: JVM.japicmpTimeoutMs, maxBuffer: 64 * 1024 * 1024 });
    // Pass 1, `-m`: every modified class with its changed members and Kotlin deprecation levels.
    await java(["-m", "--xml-file", join(scratch, "report.xml"), "-e", "*.internal.*;*.impl.*;*.shaded.*"]);
    const report = await readFile(join(scratch, "report.xml"), "utf8");
    // Pass 2: `-m` leaves out unchanged members, so the classes that lost one are listed in full,
    // and a removed overload shows what still compiles.
    const losing = classesLosingMembers(report);
    let members = new Map<string, string[][]>();
    if (losing.length) {
      await java(["-i", losing.join(";"), "--xml-file", join(scratch, "members.xml")]);
      members = memberIndex(await readFile(join(scratch, "members.xml"), "utf8"));
    }
    changes = parseJapicmp(report, members);
    kept = [
      ...new Set([
        ...liveMethodNames(report),
        ...[...members.keys()].map((k) => k.slice(k.indexOf("#") + 1)),
      ]),
    ];
    notes.push(
      `japicmp ${JVM.japicmpVersion} on ${a.artifact === b.artifact ? a.artifact : `${a.artifact}/${b.artifact}`} bytecode (internal/impl/shaded packages excluded; missing optional classes ignored)`,
    );
  } catch (error) {
    unanalyzable = true;
    notes.push(`japicmp failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const counts: SurfaceDiff["counts"] = {};
  for (const c of changes) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  const side = {
    source: { kind: "bundled" as const },
    symbols: 0,
    truncated: false,
    ms: Date.now() - started,
    integrity: "",
  };
  return {
    ecosystem: "maven",
    name,
    fromVersion: from,
    toVersion: to,
    from: side,
    to: side,
    changes,
    counts,
    moved: {},
    unanalyzable,
    notes,
    keptMethodNames: kept,
    tool: { name: "japicmp", version: JVM.japicmpVersion, noiseFilterVersion: SURFACE.noiseFilterVersion },
  };
}
