import { dirname, join, normalize } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { parse as parseToml } from "smol-toml";
import { type DependencyInstance, dependencyInstance } from "../contract";
import type { RepoTree } from "./tree";

/**
 * JVM inventory in the worker (plan S08, research jvm.md Job 1), read without running a build:
 *  - Maven: every POM of a module tree (`<modules>`), local parents inherited (`<relativePath>`,
 *    default `../pom.xml`), `${properties}` interpolated, local `dependencyManagement` applied. A
 *    direct dependency's own version always wins Maven's mediation, so a literal or interpolated
 *    version is exact; one managed by a parent or BOM outside the repo is "unresolved".
 *  - Gradle: `settings.gradle(.kts)` includes, `gradle/libs.versions.toml`, `"g:a:v"` strings and
 *    `libs.x.y` accessors in build files; `gradle.lockfile` gives exact versions per configuration.
 *    Without a lockfile the declared version is the floor Gradle starts from (a conflict elsewhere
 *    can raise it; the sandbox's dependency report decides during a fix).
 * Build scripts are programs: anything computed is left unresolved, never guessed.
 */
export interface JvmModule {
  /** Gradle project path (`:app`) or Maven module directory. */
  name: string;
  dir: string;
  manifest: string;
  lockfile: string | null;
  /**
   * Maven: where versions this module doesn't state come from outside the repo (D-28), in Maven's
   * order: the parent POM it inherits, then the BOMs its POMs import (`group:artifact:version`).
   */
  remote?: { parent: string | null; imports: string[]; props: Record<string, string> };
}

export interface JvmProject {
  root: string;
  manager: "maven" | "gradle";
  manifest: string;
  lockfile: string | null;
  modules: JvmModule[];
  instances: DependencyInstance[];
  /** `mvnw` / `gradlew` committed. */
  wrapper: boolean;
  /** Version catalog, when Gradle has one. */
  catalog: string | null;
  /** A module applies the Android Gradle Plugin (S20.1): it builds in the Android image. */
  android?: boolean;
  notes: string[];
}

/**
 * The Android Gradle Plugin's ids, in a build file (`id("com.android.application")`, `apply plugin:
 * 'com.android.library'`) or the version catalog a build file's `alias(libs.plugins.…)` reads.
 */
const ANDROID_PLUGIN =
  /["']com\.android\.(?:application|library|test|dynamic-feature|kotlin\.multiplatform\.library)["']/;

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
/** A POM list element that may be one item or several. */
export const asPomArray = asArray;
export const VERSION = /^[0-9][0-9A-Za-z.+_-]*$/;

interface PomDep {
  groupId?: string;
  artifactId?: string;
  version?: string;
  scope?: string;
  optional?: string;
  type?: string;
}
interface PomPlugin {
  groupId?: string;
  artifactId?: string;
  version?: string;
}
interface PomBuild {
  plugins?: { plugin?: PomPlugin | PomPlugin[] };
  pluginManagement?: { plugins?: { plugin?: PomPlugin | PomPlugin[] } };
  extensions?: { extension?: PomPlugin | PomPlugin[] };
}
interface PomProfile {
  id?: string;
  activation?: {
    activeByDefault?: boolean | string;
    jdk?: string | number;
    os?: unknown;
    property?: { name?: string; value?: string | number };
    file?: unknown;
    packaging?: string;
  };
  dependencies?: { dependency?: PomDep | PomDep[] };
  build?: PomBuild;
}

/**
 * Profiles a build here activates by name (Codex S18 review #11): `-P a,b` or
 * `--activate-profiles` in `.mvn/maven.config` and on a CI workflow's `mvn`/`mvnw` lines.
 */
function namedProfiles(tree: RepoTree, root: string) {
  const config = tree.read(root === "." ? ".mvn/maven.config" : join(root, ".mvn/maven.config")) ?? "";
  const lines = [
    config,
    ...tree
      .files()
      .filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
      .flatMap((f) => (tree.read(f) ?? "").split("\n").filter((l) => /\bmvnw?\b/.test(l))),
  ];
  const on = new Set<string>();
  for (const line of lines)
    for (const m of line.matchAll(/(?:^|\s)(?:-P\s*|--activate-profiles[=\s]+)([\w.,!?+-]+)/g))
      for (const id of (m[1] ?? "").split(",")) if (id && !/^[!-]/.test(id)) on.add(id.replace(/^[+?]/, ""));
  return on;
}

/**
 * Why a profile's dependencies may not be in the build, or null when the default build or CI has
 * it on: active by default, named with `-P`, or switched on by a property's absence (`!skipIt`).
 */
function profileCondition(profile: PomProfile, named: Set<string>): string | null {
  const a = profile.activation;
  if ((profile.id && named.has(profile.id)) || String(a?.activeByDefault) === "true") return null;
  const prop = a?.property;
  if (prop?.name?.startsWith("!") && prop.value === undefined && !a?.jdk && !a?.os && !a?.file) return null;
  const when = [
    a?.jdk !== undefined && `JDK ${a.jdk}`,
    a?.os !== undefined && "an operating system match",
    prop?.name && `property ${prop.name}${prop.value !== undefined ? `=${prop.value}` : ""}`,
    a?.file !== undefined && "a file check",
    a?.packaging && `packaging ${a.packaging}`,
  ].filter(Boolean);
  return when.length
    ? `active only with ${when.join(" and ")}`
    : `active only with -P ${profile.id ?? ""}`.trim();
}
export interface Pom {
  parent?: { groupId?: string; artifactId?: string; version?: string; relativePath?: string };
  groupId?: string;
  artifactId?: string;
  version?: string;
  modules?: { module?: string | string[] };
  properties?: Record<string, string>;
  dependencyManagement?: { dependencies?: { dependency?: PomDep | PomDep[] } };
  dependencies?: { dependency?: PomDep | PomDep[] };
  build?: PomBuild;
  profiles?: { profile?: PomProfile | PomProfile[] };
}

/** A POM's text as the model Teire reads (also for POMs fetched from a repository, D-28). */
export function parsePom(text: string): Pom | null {
  try {
    return ((xml.parse(text) as { project?: Pom }).project ?? null) as Pom | null;
  } catch {
    return null;
  }
}

/** Maven's default plugin group, when a `<plugin>` names none. */
export const MAVEN_PLUGIN_GROUP = "org.apache.maven.plugins";
/** A BOM import: `<type>pom</type><scope>import</scope>` in `<dependencyManagement>`. */
export const isBomImport = (d: PomDep) => d.scope === "import" && (d.type ?? "jar") === "pom";

function readPom(tree: RepoTree, path: string): Pom | null {
  const text = tree.read(path);
  return text === null ? null : parsePom(text);
}

function scopeOf(scope: string | undefined, optional: string | undefined): DependencyInstance["scope"] {
  if (optional === "true") return "optional";
  if (scope === "test") return "test";
  if (scope === "provided" || scope === "system") return "build";
  return "prod";
}

/** Properties and managed versions a POM sees: its own over its local parent chain's. */
interface PomContext {
  pom: Pom | null;
  props: Record<string, string>;
  managed: Map<string, string>;
  /** Plugin versions from local `<pluginManagement>` sections. */
  managedPlugins: Map<string, string>;
  /** A parent POM the repo does not contain (its properties and managed versions are unknown). */
  external: boolean;
  /** That parent's coordinate, `group:artifact:version`, when its version is stated. */
  externalParent: string | null;
  /** BOMs this POM and its local parents import, nearest first. */
  imports: string[];
}

function pomContext(tree: RepoTree, path: string, seen = new Set<string>()): PomContext {
  const pom = readPom(tree, path);
  const props: Record<string, string> = {};
  const managed = new Map<string, string>();
  const managedPlugins = new Map<string, string>();
  const empty = { pom, props, managed, managedPlugins, external: false, externalParent: null, imports: [] };
  if (!pom || seen.has(path)) return empty;
  seen.add(path);
  let external = false;
  let externalParent: string | null = null;
  let inherited: string[] = [];
  if (pom.parent) {
    const rel = typeof pom.parent.relativePath === "string" ? pom.parent.relativePath : "../pom.xml";
    const parentPath = normalize(join(dirname(path), rel.endsWith(".xml") ? rel : join(rel, "pom.xml")));
    if (rel !== "" && tree.read(parentPath) !== null) {
      const up = pomContext(tree, parentPath, seen);
      Object.assign(props, up.props);
      for (const [k, v] of up.managed) managed.set(k, v);
      for (const [k, v] of up.managedPlugins) managedPlugins.set(k, v);
      external = up.external;
      externalParent = up.externalParent;
      inherited = up.imports;
    } else {
      external = true;
      const { groupId, artifactId, version } = pom.parent;
      externalParent = groupId && artifactId && version ? `${groupId}:${artifactId}:${version}` : null;
    }
  }
  for (const [k, v] of Object.entries(pom.properties ?? {})) props[k] = String(v);
  const version = pom.version ?? pom.parent?.version;
  if (version) Object.assign(props, { "project.version": version, version, "pom.version": version });
  const interpolate = (s: string) => interpolateWith(props, s);
  const own: string[] = [];
  for (const d of asArray(pom.dependencyManagement?.dependencies?.dependency)) {
    if (!d.groupId || !d.artifactId || !d.version) continue;
    if (isBomImport(d))
      own.push(`${interpolate(d.groupId)}:${interpolate(d.artifactId)}:${interpolate(d.version)}`);
    else managed.set(`${interpolate(d.groupId)}:${interpolate(d.artifactId)}`, interpolate(d.version));
  }
  for (const pl of asArray(pom.build?.pluginManagement?.plugins?.plugin))
    if (pl.artifactId && pl.version)
      managedPlugins.set(
        `${interpolate(pl.groupId ?? MAVEN_PLUGIN_GROUP)}:${interpolate(pl.artifactId)}`,
        interpolate(pl.version),
      );
  // Inheritance comes before import, so the parents' imports follow this POM's own (Maven's model).
  return { pom, props, managed, managedPlugins, external, externalParent, imports: [...own, ...inherited] };
}

export function interpolateWith(props: Record<string, string>, s: string, depth = 0): string {
  const out = s.replace(/\$\{([^}]+)\}/g, (m, k: string) => (props[k] !== undefined ? props[k] : m));
  return out !== s && depth < 5 && out.includes("${") ? interpolateWith(props, out, depth + 1) : out;
}

function readMaven(tree: RepoTree): JvmProject[] {
  const poms = tree
    .files()
    .filter((f) => /(?:^|\/)pom\.xml$/.test(f) && !/(?:^|\/)(?:target|src|node_modules|\.mvn)\//.test(f));
  const listed = new Set<string>();
  for (const p of poms)
    for (const m of asArray(readPom(tree, p)?.modules?.module))
      listed.add(normalize(join(dirname(p), String(m), "pom.xml")));
  const roots = poms.filter((p) => !listed.has(p));
  const projects: JvmProject[] = [];
  for (const rootPom of roots) {
    const root = dirname(rootPom);
    const modules: JvmModule[] = [];
    const walk = (path: string) => {
      if (modules.some((m) => m.manifest === path)) return;
      const pom = readPom(tree, path);
      if (!pom) return;
      modules.push({ name: dirname(path), dir: dirname(path), manifest: path, lockfile: null });
      for (const m of asArray(pom.modules?.module))
        walk(normalize(join(dirname(path), String(m), "pom.xml")));
    };
    walk(rootPom);
    const named = namedProfiles(tree, root);
    const notes: string[] = [];
    const instances: DependencyInstance[] = [];
    for (const mod of modules) {
      const ctx = pomContext(tree, mod.manifest);
      const pom = ctx.pom;
      if (ctx.external || ctx.imports.length)
        mod.remote = {
          parent: ctx.external ? ctx.externalParent : null,
          imports: ctx.imports,
          props: ctx.props,
        };
      const add = (
        groupId: string,
        artifactId: string,
        raw: string | undefined,
        fields: {
          scope: DependencyInstance["scope"];
          role?: DependencyInstance["role"];
          managed?: string;
          /** A profile no build here is known to activate: listed, not compared (Codex S18 review #11). */
          profile?: { id: string; condition: string };
        },
        manifestPath = mod.manifest,
      ) => {
        const name = `${interpolateWith(ctx.props, groupId)}:${interpolateWith(ctx.props, artifactId)}`;
        const stated = raw ?? fields.managed;
        const version = stated ? interpolateWith(ctx.props, stated) : null;
        const exact = version && VERSION.test(version) && !fields.profile ? version : null;
        const reason = fields.profile
          ? `in Maven profile "${fields.profile.id}", ${fields.profile.condition}: not compared until a build here activates it`
          : !stated
            ? fields.role === "plugin"
              ? "no version in the repo: the parent POM or Maven's own defaults set it"
              : "version managed outside the repo (remote parent or imported BOM)"
            : !exact
              ? `version "${stated}" is not a literal version or a property defined in the repo`
              : undefined;
        const parsed = dependencyInstance.safeParse({
          ecosystem: "maven",
          name,
          version: exact,
          ...(raw ? { declaredRange: raw } : {}),
          direct: true,
          scope: fields.scope,
          workspace: mod.dir,
          manifestPath,
          source: "registry",
          resolvedBy: exact ? "toolchain" : "unresolved",
          ...(fields.role ? { role: fields.role } : {}),
          ...(reason ? { unresolvedReason: reason } : {}),
        });
        if (parsed.success && !instances.some((i) => i.name === name && i.workspace === mod.dir))
          instances.push(parsed.data);
      };
      // Dependencies, the module's own and each profile's: an active profile's count as the
      // module's; another's are listed with the condition that would switch them on.
      // Active profiles first: a dependency both declare is the active one's.
      const profiles = asArray(pom?.profiles?.profile)
        .map((pr) => {
          const condition = profileCondition(pr, named);
          return { pr, ...(condition ? { profile: { id: pr.id ?? "(unnamed)", condition } } : {}) };
        })
        .sort((a, b) => Number(!!a.profile) - Number(!!b.profile));
      for (const { d, profile } of [
        ...asArray(pom?.dependencies?.dependency).map((d) => ({ d, profile: undefined })),
        ...profiles.flatMap(({ pr, profile }) =>
          asArray(pr.dependencies?.dependency).map((d) => ({ d, profile })),
        ),
      ])
        if (d.groupId && d.artifactId)
          add(d.groupId, d.artifactId, d.version, {
            scope: scopeOf(d.scope, d.optional),
            managed: ctx.managed.get(
              `${interpolateWith(ctx.props, d.groupId)}:${interpolateWith(ctx.props, d.artifactId)}`,
            ),
            ...(profile ? { profile } : {}),
          });
      // The parent this module inherits from outside the repo, and the BOMs its own POM imports (S18.3).
      if (pom?.parent && ctx.external && pom.parent.groupId && pom.parent.artifactId)
        add(pom.parent.groupId, pom.parent.artifactId, pom.parent.version, {
          scope: "build",
          role: "parent",
        });
      for (const d of asArray(pom?.dependencyManagement?.dependencies?.dependency))
        if (isBomImport(d) && d.groupId && d.artifactId)
          add(d.groupId, d.artifactId, d.version, { scope: "build", role: "bom" });
      // Plugins and build extensions, with their managed versions where the repo states them.
      const builds = [
        { b: pom?.build, profile: undefined },
        ...profiles.map(({ pr, profile }) => ({ b: pr.build, profile })),
      ];
      for (const { b, profile } of builds)
        for (const pl of [...asArray(b?.plugins?.plugin), ...asArray(b?.pluginManagement?.plugins?.plugin)])
          if (pl.artifactId) {
            const groupId = pl.groupId ?? MAVEN_PLUGIN_GROUP;
            add(groupId, pl.artifactId, pl.version, {
              scope: "build",
              role: "plugin",
              managed: ctx.managedPlugins.get(
                `${interpolateWith(ctx.props, groupId)}:${interpolateWith(ctx.props, pl.artifactId)}`,
              ),
              ...(profile ? { profile } : {}),
            });
          }
      for (const { b, profile } of builds)
        for (const ex of asArray(b?.extensions?.extension))
          if (ex.groupId && ex.artifactId)
            add(ex.groupId, ex.artifactId, ex.version, {
              scope: "build",
              role: "extension",
              ...(profile ? { profile } : {}),
            });
      if (ctx.external && !ctx.externalParent)
        notes.push(`${mod.manifest}: parent POM outside the repo with no version stated`);
    }
    // Core extensions (`.mvn/extensions.xml`, D-29) and the Maven wrapper's distribution, once per build.
    const at = (p: string) => (root === "." ? p : join(root, p));
    const top = modules[0];
    const extensions = tree.read(at(".mvn/extensions.xml"));
    if (top && extensions) {
      try {
        const doc = xml.parse(extensions) as { extensions?: { extension?: PomPlugin | PomPlugin[] } };
        for (const ex of asArray(doc.extensions?.extension)) {
          if (!ex.groupId || !ex.artifactId) continue;
          const exact = ex.version && VERSION.test(ex.version) ? ex.version : null;
          const parsed = dependencyInstance.safeParse({
            ecosystem: "maven",
            name: `${ex.groupId}:${ex.artifactId}`,
            version: exact,
            ...(ex.version ? { declaredRange: ex.version } : {}),
            direct: true,
            scope: "build",
            workspace: top.dir,
            manifestPath: at(".mvn/extensions.xml"),
            source: "registry",
            resolvedBy: exact ? "toolchain" : "unresolved",
            role: "extension",
            ...(exact ? {} : { unresolvedReason: "no literal version in .mvn/extensions.xml" }),
          });
          if (parsed.success) instances.push(parsed.data);
        }
      } catch (error) {
        notes.push(`.mvn/extensions.xml: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const wrapperPath = at(".mvn/wrapper/maven-wrapper.properties");
    const maven =
      /^distributionUrl=.*\/apache-maven\/([^/\s]+)\/apache-maven-[^/\s]+\.(?:zip|tar\.gz)\s*$/m.exec(
        tree.read(wrapperPath) ?? "",
      )?.[1];
    if (top && maven) {
      const parsed = dependencyInstance.safeParse({
        ecosystem: "maven",
        name: "org.apache.maven:apache-maven",
        version: VERSION.test(maven) ? maven : null,
        declaredRange: maven,
        direct: true,
        scope: "build",
        workspace: top.dir,
        manifestPath: wrapperPath,
        source: "registry",
        resolvedBy: VERSION.test(maven) ? "toolchain" : "unresolved",
        role: "wrapper",
      });
      if (parsed.success) instances.push(parsed.data);
    }
    notes.push("Maven has no lockfile: transitive versions are resolved in the sandbox (dependency:tree)");
    projects.push({
      root,
      manager: "maven",
      manifest: rootPom,
      lockfile: null,
      modules,
      instances,
      wrapper: tree.read(join(root, "mvnw")) !== null,
      catalog: null,
      notes,
    });
  }
  return projects;
}

/**
 * `include(":app", ":lib")`, `include ':app'`, `include("app")` → Gradle project paths, including an
 * `include` whose list spans several lines (D-27): inside parentheses to the closing one, or a Groovy
 * list continued by trailing commas.
 */
export function gradleIncludes(settings: string) {
  const out: string[] = [];
  const text = settings.replace(/\/\/[^\n]*/g, "");
  for (const m of text.matchAll(/^\s*include\b\s*(\()?/gm)) {
    const start = (m.index ?? 0) + m[0].length;
    let body: string;
    if (m[1]) {
      const close = text.indexOf(")", start);
      body = text.slice(start, close < 0 ? undefined : close);
    } else {
      // Without parentheses: this line, and the next ones while a line ends with a comma.
      const lines: string[] = [];
      for (const line of text.slice(start).split("\n")) {
        lines.push(line);
        if (!/,\s*$/.test(line)) break;
      }
      body = lines.join("\n");
    }
    for (const p of body.matchAll(/["']([^"']+)["']/g))
      out.push(p[1]?.startsWith(":") ? (p[1] as string) : `:${p[1]}`);
  }
  return [...new Set(out)];
}

/** `project(":app").projectDir = file("apps/android")` (Groovy or Kotlin) → project path → folder (D-27). */
export function gradleProjectDirs(settings: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of settings.matchAll(
    /project\(\s*["'](:?[^"']+)["']\s*\)\.projectDir\s*=\s*(?:new\s+File\s*\(\s*settingsDir\s*,\s*|file\s*\(\s*)["']([^"']+)["']/g,
  )) {
    const path = (m[1] ?? "").startsWith(":") ? (m[1] as string) : `:${m[1]}`;
    out.set(path, (m[2] ?? "").replace(/^\.\//, "").replace(/\/$/, ""));
  }
  return out;
}

interface Catalog {
  versions: Record<string, string>;
  /** `[plugins]` accessor (`spring.boot`) → { id, version | null, ref } (S18.1). */
  plugins: Map<string, { id: string; version: string | null; ref: string | null }>;
  /** Accessor (`okhttp.logging`) → { module, version | null, ref }. */
  libraries: Map<string, { module: string; version: string | null; ref: string | null; key: string }>;
}

export function readCatalog(text: string): Catalog {
  const doc = parseToml(text) as {
    versions?: Record<string, unknown>;
    libraries?: Record<string, unknown>;
    plugins?: Record<string, unknown>;
  };
  const versions: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc.versions ?? {}))
    versions[k] =
      typeof v === "string"
        ? v
        : String(
            (v as { strictly?: string; require?: string; prefer?: string }).strictly ??
              (v as { require?: string }).require ??
              (v as { prefer?: string }).prefer ??
              "",
          );
  const libraries = new Map<
    string,
    { module: string; version: string | null; ref: string | null; key: string }
  >();
  for (const [key, v] of Object.entries(doc.libraries ?? {})) {
    let module = "";
    let version: string | null = null;
    let ref: string | null = null;
    if (typeof v === "string") {
      const [g, a, ver] = v.split(":");
      module = `${g}:${a}`;
      version = ver ?? null;
    } else {
      const o = v as {
        module?: string;
        group?: string;
        name?: string;
        version?: string | { ref?: string; strictly?: string; require?: string };
      };
      module = o.module ?? `${o.group}:${o.name}`;
      if (typeof o.version === "string") version = o.version;
      else if (o.version?.ref) {
        ref = o.version.ref;
        version = versions[ref] ?? null;
      } else if (o.version) version = o.version.strictly ?? o.version.require ?? null;
    }
    // Gradle's accessor: separators `-`, `_`, `.` all become `.`.
    libraries.set(key.replace(/[-_]/g, "."), { module, version, ref, key });
  }
  const plugins = new Map<string, { id: string; version: string | null; ref: string | null }>();
  for (const [key, v] of Object.entries(doc.plugins ?? {})) {
    if (typeof v === "string") {
      const [id, ver] = v.split(":");
      if (id) plugins.set(key.replace(/[-_]/g, "."), { id, version: ver ?? null, ref: null });
      continue;
    }
    const o = v as { id?: string; version?: string | { ref?: string } };
    if (!o.id) continue;
    const ref = typeof o.version === "object" ? (o.version.ref ?? null) : null;
    plugins.set(key.replace(/[-_]/g, "."), {
      id: o.id,
      version: typeof o.version === "string" ? o.version : ref ? (versions[ref] ?? null) : null,
      ref,
    });
  }
  return { versions, libraries, plugins };
}

/**
 * Any configuration call that names a coordinate (D-26): the built-in ones, Android's variant ones
 * (`debugImplementation`), `testFixtures*`, `classpath`, custom configurations and BOM imports
 * (`platform(…)`, `enforcedPlatform(…)`, `mavenBom(…)`). A coordinate is `group:artifact[:version]`
 * or a catalog accessor; calls that take other strings are left out by name.
 */
const GRADLE_CONFIG =
  /\b([a-zA-Z]\w*)\b\s*\(?\s*(?:(platform|enforcedPlatform)\s*\(\s*)?(?:"([\w.-]+:[\w.-]+(?::(?:\$\{?\w+\}?|[^"$:]*))?)"|'([\w.-]+:[\w.-]+(?::(?:\$\{?\w+\}?|[^'$:]*))?)'|(libs\.[\w.]+))/g;
/** Map notation (S18.3): Groovy `implementation group: 'g', name: 'a', version: 'v'`, Kotlin `(group = …)`. */
const GRADLE_MAP =
  /\b([a-zA-Z]\w*)\b\s*\(?\s*group\s*[:=]\s*["']([\w.-]+)["']\s*,\s*name\s*[:=]\s*["']([\w.-]+)["'](?:\s*,\s*version\s*[:=]\s*["']([^"']+)["'])?/g;

/**
 * Version variables a Gradle build defines (S18.3): `gradle.properties`, Kotlin `val x = "1.2"`,
 * Groovy `def x = '1.2'`, `ext.x = '1.2'`, an `ext { x = '1.2' }` block, `extra["x"] = "1.2"`,
 * `val x by extra("1.2")` and `set("x", "1.2")`. Computed values are not variables.
 */
export function gradleVariables(texts: string[], properties: string | null) {
  const out = new Map<string, string>();
  for (const line of (properties ?? "").split("\n")) {
    const m = /^\s*([\w.-]+)\s*[=:]\s*([^\s#]+)\s*$/.exec(line);
    if (m?.[1] && m[2]) out.set(m[1], m[2]);
  }
  const literal = `["']([^"'$\\n]+)["']`;
  const patterns = [
    new RegExp(`^\\s*(?:val|var|def|String)\\s+(\\w+)\\s*(?::\\s*String\\s*)?=\\s*${literal}`, "gm"),
    new RegExp(`\\bext\\.(\\w+)\\s*=\\s*${literal}`, "g"),
    new RegExp(`\\bextra\\[\\s*["'](\\w+)["']\\s*\\]\\s*=\\s*${literal}`, "g"),
    new RegExp(`\\bval\\s+(\\w+)\\s+by\\s+extra\\(\\s*${literal}\\s*\\)`, "g"),
    new RegExp(`\\bset\\(\\s*["'](\\w+)["']\\s*,\\s*${literal}\\s*\\)`, "g"),
  ];
  for (const text of texts) {
    for (const re of patterns) for (const m of text.matchAll(re)) if (m[1] && m[2]) out.set(m[1], m[2]);
    for (const block of text.matchAll(/\bext\s*\{([\s\S]*?)\}/g))
      for (const m of (block[1] ?? "").matchAll(new RegExp(`^\\s*(\\w+)\\s*=\\s*${literal}`, "gm")))
        if (m[1] && m[2]) out.set(m[1], m[2]);
  }
  return out;
}

/** `"$kotlinVersion"` / `"${kotlin_version}"` → the variable's name. */
const gradleVariable = (version: string) => /^\$\{?(\w+)\}?$/.exec(version)?.[1] ?? null;
const NOT_A_CONFIGURATION = new Set([
  "id",
  "alias",
  "plugin",
  "project",
  "files",
  "exclude",
  "group",
  "module",
  "include",
  "url",
  "uri",
  "file",
  "version",
]);

/** A plugins-block line with a version: Groovy `id 'x' version 'y'` and Kotlin `id("x") version "y"`. */
const GRADLE_PLUGIN = /\bid\s*\(?\s*["']([\w.-]+)["']\s*\)?\s+version\s*\(?\s*["']([^"'$]+)["']/g;

/** `gradle.lockfile`: `g:a:v=conf1,conf2` (research jvm.md Job 1). */
export function parseGradleLockfile(text: string) {
  const out: { name: string; version: string; configurations: string[] }[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("empty=")) continue;
    const eq = t.lastIndexOf("=");
    const [g, a, v] = t.slice(0, eq).split(":");
    if (!g || !a || !v) continue;
    out.push({
      name: `${g}:${a}`,
      version: v,
      configurations: t
        .slice(eq + 1)
        .split(",")
        .filter(Boolean),
    });
  }
  return out;
}

function readGradle(tree: RepoTree): JvmProject[] {
  const settingsFiles = tree
    .files()
    .filter(
      (f) => /(?:^|\/)settings\.gradle(?:\.kts)?$/.test(f) && !/(?:^|\/)(?:buildSrc|node_modules)\//.test(f),
    );
  const roots = settingsFiles.length
    ? settingsFiles.map((s) => ({ root: dirname(s), settings: s }))
    : tree
        .files()
        .filter((f) => /^build\.gradle(?:\.kts)?$/.test(f))
        .map((f) => ({ root: ".", settings: f }));
  // An included build (`includeBuild("build-logic")`) is a build of its own; one without its own
  // settings file is read from its build file (S18.3).
  for (const { root, settings } of [...roots]) {
    for (const m of (tree.read(settings) ?? "").matchAll(/\bincludeBuild\s*\(?\s*["']([^"']+)["']/g)) {
      const dir = normalize(join(root, (m[1] as string).replace(/\/$/, "")));
      if (dir.startsWith("..") || roots.some((r) => r.root === dir)) continue;
      const build = [join(dir, "build.gradle.kts"), join(dir, "build.gradle")].find(
        (f) => tree.read(f) !== null,
      );
      if (build) roots.push({ root: dir, settings: build });
    }
  }
  const projects: JvmProject[] = [];
  for (const { root, settings } of roots) {
    const at = (p: string) => (root === "." ? p : join(root, p));
    const settingsText = /settings\.gradle(?:\.kts)?$/.test(settings) ? (tree.read(settings) ?? "") : "";
    const projectPaths = [":", ...gradleIncludes(settingsText)];
    const projectDirs = gradleProjectDirs(settingsText);
    const catalogPath = at("gradle/libs.versions.toml");
    const catalogText = tree.read(catalogPath);
    let catalog: Catalog | null = null;
    const notes: string[] = [];
    try {
      catalog = catalogText ? readCatalog(catalogText) : null;
    } catch (error) {
      notes.push(`${catalogPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const modules: JvmModule[] = [];
    const instances: DependencyInstance[] = [];
    const builds: { p: string; dir: string; manifest: string }[] = [];
    for (const p of projectPaths) {
      const moved = projectDirs.get(p);
      const dir = p === ":" ? root : moved ? at(moved) : at(p.slice(1).replace(/:/g, "/"));
      const manifest = [join(dir, "build.gradle.kts"), join(dir, "build.gradle")].find(
        (f) => tree.read(f) !== null,
      );
      if (manifest) builds.push({ p, dir, manifest });
    }
    // buildSrc (S18.3): its build file and the convention plugins under src/main, whose
    // `dependencies` apply to the projects that use them.
    const buildSrc = at("buildSrc");
    for (const manifest of tree.files()) {
      const own =
        manifest === join(buildSrc, "build.gradle.kts") || manifest === join(buildSrc, "build.gradle");
      const convention = manifest.startsWith(`${buildSrc}/src/main/`) && /\.gradle(?:\.kts)?$/.test(manifest);
      if (own || convention)
        builds.push({
          p: own ? ":buildSrc" : `:buildSrc:${manifest.slice(manifest.lastIndexOf("/") + 1)}`,
          dir: buildSrc,
          manifest,
        });
    }
    const variables = gradleVariables(
      builds.map((b) => tree.read(b.manifest) ?? ""),
      tree.read(at("gradle.properties")),
    );
    for (const { p, dir, manifest } of builds) {
      const lockPath = join(dir, "gradle.lockfile");
      const lockText = p.startsWith(":buildSrc:") ? null : tree.read(lockPath);
      modules.push({ name: p, dir, manifest, lockfile: lockText !== null ? lockPath : null });
      const text = tree.read(manifest) ?? "";
      const locked = lockText !== null ? parseGradleLockfile(lockText) : null;
      const declared = new Map<
        string,
        { version: string | null; config: string; declaredAs: string; bom?: boolean }
      >();
      // Plugins (S18.1): `id 'x' version 'y'`, `id("x") version "y"` and catalog aliases, as their
      // marker coordinate `x:x.gradle.plugin`, which is how Gradle and Dependabot resolve them.
      for (const m of text.matchAll(GRADLE_PLUGIN)) {
        const id = m[1] as string;
        declared.set(`${id}:${id}.gradle.plugin`, {
          version: m[2] ?? null,
          config: "plugin",
          declaredAs: `id ${id}`,
        });
      }
      for (const m of text.matchAll(/\balias\(\s*libs\.plugins\.([\w.]+)\s*\)/g)) {
        const plugin = catalog?.plugins.get(m[1] as string);
        if (plugin)
          declared.set(`${plugin.id}:${plugin.id}.gradle.plugin`, {
            version: plugin.version,
            config: "plugin",
            declaredAs: `libs.plugins.${m[1]}`,
          });
      }
      for (const m of text.matchAll(GRADLE_CONFIG)) {
        const config = m[1] as string;
        if (NOT_A_CONFIGURATION.has(config)) continue;
        const bom = Boolean(m[2]);
        const notation = m[3] ?? m[4];
        if (notation) {
          const [g, a, v] = notation.split(":");
          if (g && a) declared.set(`${g}:${a}`, { version: v || null, config, declaredAs: notation, bom });
        } else if (m[5] && catalog) {
          const lib = catalog.libraries.get(m[5].slice(5));
          if (lib) declared.set(lib.module, { version: lib.version, config, declaredAs: m[5], bom });
        }
      }
      for (const m of text.matchAll(GRADLE_MAP)) {
        const config = m[1] as string;
        if (NOT_A_CONFIGURATION.has(config) || !m[2] || !m[3]) continue;
        declared.set(`${m[2]}:${m[3]}`, {
          version: m[4] ?? null,
          config,
          declaredAs: `group: ${m[2]}, name: ${m[3]}`,
        });
      }
      const lockedVersion = (name: string, test: boolean) =>
        locked
          ?.filter((l) => l.name === name)
          .find((l) =>
            l.configurations.some((c) =>
              (test ? /^test(Compile|Runtime)Classpath$/ : /^(compile|runtime)Classpath$/).test(c),
            ),
          )?.version ?? null;
      for (const [name, d] of declared) {
        const test = /^(test|androidTest)/.test(d.config);
        const fromLock = locked ? (lockedVersion(name, test) ?? lockedVersion(name, !test)) : null;
        const variable = d.version ? gradleVariable(d.version) : null;
        const stated = variable ? (variables.get(variable) ?? null) : d.version;
        const literal = stated && VERSION.test(stated) ? stated : null;
        const version = fromLock ?? literal;
        const parsed = dependencyInstance.safeParse({
          ecosystem: "maven",
          name,
          version,
          ...(d.version ? { declaredRange: d.version } : {}),
          direct: true,
          scope: test
            ? "test"
            : d.config === "compileOnly" || d.config === "plugin"
              ? "build"
              : /kapt|ksp|annotationProcessor/.test(d.config)
                ? "build"
                : "prod",
          workspace: p,
          manifestPath: manifest,
          ...(locked ? { lockfilePath: lockPath } : {}),
          source: "registry",
          resolvedBy: fromLock ? "lockfile" : literal ? "toolchain" : "unresolved",
          ...(d.config === "plugin" ? { role: "plugin" } : d.bom ? { role: "bom" } : {}),
          ...(!version
            ? {
                unresolvedReason: variable
                  ? `version variable ${variable} is not defined as a literal in the build`
                  : d.version
                    ? `version "${d.version}" is not a literal version`
                    : "no version in the build file (a platform/BOM or plugin sets it)",
              }
            : {}),
        });
        if (parsed.success) instances.push(parsed.data);
      }
      // Transitive versions only where a lockfile records them, from the app's classpaths.
      for (const l of locked ?? []) {
        if (declared.has(l.name)) continue;
        if (!l.configurations.some((c) => /^(compile|runtime|testCompile|testRuntime)Classpath$/.test(c)))
          continue;
        if (instances.some((i) => i.name === l.name && i.workspace === p)) continue;
        const parsed = dependencyInstance.safeParse({
          ecosystem: "maven",
          name: l.name,
          version: l.version,
          direct: false,
          scope: l.configurations.some((c) => /^(compile|runtime)Classpath$/.test(c)) ? "prod" : "test",
          workspace: p,
          manifestPath: manifest,
          lockfilePath: lockPath,
          source: "registry",
          resolvedBy: "lockfile",
        });
        if (parsed.success) instances.push(parsed.data);
      }
    }
    // The Gradle wrapper as a candidate of its own (D-30): its versions come from services.gradle.org.
    const wrapperPath = at("gradle/wrapper/gradle-wrapper.properties");
    const gradle = /^distributionUrl=.*gradle-(\d+(?:\.\d+)*(?:-rc-\d+)?)-(?:bin|all)\.zip\s*$/m.exec(
      tree.read(wrapperPath) ?? "",
    )?.[1];
    const first = modules[0];
    if (gradle && first) {
      const parsed = dependencyInstance.safeParse({
        ecosystem: "maven",
        name: GRADLE_WRAPPER,
        version: gradle,
        declaredRange: gradle,
        direct: true,
        scope: "build",
        workspace: first.name,
        manifestPath: wrapperPath,
        source: "registry",
        resolvedBy: "toolchain",
        role: "wrapper",
      });
      if (parsed.success) instances.push(parsed.data);
    }
    if (!modules.some((m) => m.lockfile))
      notes.push("no gradle.lockfile: declared versions are the floor (conflict resolution can raise them)");
    const android = [
      ...modules.map((m) => tree.read(m.manifest) ?? ""),
      tree.read(settings) ?? "",
      catalogText ?? "",
    ].some((text) => ANDROID_PLUGIN.test(text));
    if (android)
      notes.push("Android Gradle Plugin: checks run in the Android image (SDK platforms 35 and 36)");
    projects.push({
      root,
      manager: "gradle",
      manifest: modules[0]?.manifest ?? settings,
      lockfile: modules.find((m) => m.lockfile)?.lockfile ?? null,
      modules,
      instances,
      wrapper: tree.read(at("gradlew")) !== null,
      catalog: catalogText !== null ? catalogPath : null,
      ...(android ? { android } : {}),
      notes,
    });
  }
  return projects;
}

/** The Gradle wrapper's name as a dependency (Dependabot's own name for it). */
export const GRADLE_WRAPPER = "gradle-wrapper";

export function readJvmInventory(tree: RepoTree): JvmProject[] {
  return [...readMaven(tree), ...readGradle(tree)];
}
