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
  notes: string[];
}

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const VERSION = /^[0-9][0-9A-Za-z.+_-]*$/;

interface PomDep {
  groupId?: string;
  artifactId?: string;
  version?: string;
  scope?: string;
  optional?: string;
  type?: string;
}
interface Pom {
  parent?: { groupId?: string; artifactId?: string; version?: string; relativePath?: string };
  groupId?: string;
  artifactId?: string;
  version?: string;
  modules?: { module?: string | string[] };
  properties?: Record<string, string>;
  dependencyManagement?: { dependencies?: { dependency?: PomDep | PomDep[] } };
  dependencies?: { dependency?: PomDep | PomDep[] };
}

function readPom(tree: RepoTree, path: string): Pom | null {
  const text = tree.read(path);
  if (text === null) return null;
  try {
    return ((xml.parse(text) as { project?: Pom }).project ?? null) as Pom | null;
  } catch {
    return null;
  }
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
  /** A parent POM the repo does not contain (its properties and managed versions are unknown). */
  external: boolean;
}

function pomContext(tree: RepoTree, path: string, seen = new Set<string>()): PomContext {
  const pom = readPom(tree, path);
  const props: Record<string, string> = {};
  const managed = new Map<string, string>();
  if (!pom || seen.has(path)) return { pom, props, managed, external: false };
  seen.add(path);
  let external = false;
  if (pom.parent) {
    const rel = typeof pom.parent.relativePath === "string" ? pom.parent.relativePath : "../pom.xml";
    const parentPath = normalize(join(dirname(path), rel.endsWith(".xml") ? rel : join(rel, "pom.xml")));
    if (rel !== "" && tree.read(parentPath) !== null) {
      const up = pomContext(tree, parentPath, seen);
      Object.assign(props, up.props);
      for (const [k, v] of up.managed) managed.set(k, v);
      external = up.external;
    } else external = true;
  }
  for (const [k, v] of Object.entries(pom.properties ?? {})) props[k] = String(v);
  const version = pom.version ?? pom.parent?.version;
  if (version) Object.assign(props, { "project.version": version, version, "pom.version": version });
  const interpolate = (s: string) =>
    s.replace(/\$\{([^}]+)\}/g, (m, k: string) => (props[k] !== undefined ? props[k] : m));
  for (const d of asArray(pom.dependencyManagement?.dependencies?.dependency))
    if (d.groupId && d.artifactId && d.version && d.scope !== "import")
      managed.set(`${interpolate(d.groupId)}:${interpolate(d.artifactId)}`, interpolate(d.version));
  return { pom, props, managed, external };
}

function interpolateWith(props: Record<string, string>, s: string, depth = 0): string {
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
    const notes: string[] = [];
    const instances: DependencyInstance[] = [];
    for (const mod of modules) {
      const ctx = pomContext(tree, mod.manifest);
      if (ctx.external)
        notes.push(`${mod.manifest}: parent POM outside the repo (its managed versions are not read)`);
      for (const d of asArray(ctx.pom?.dependencies?.dependency)) {
        if (!d.groupId || !d.artifactId) continue;
        const name = `${interpolateWith(ctx.props, d.groupId)}:${interpolateWith(ctx.props, d.artifactId)}`;
        const raw = d.version ?? ctx.managed.get(name);
        const version = raw ? interpolateWith(ctx.props, raw) : null;
        const exact = version && VERSION.test(version) ? version : null;
        const reason = !raw
          ? "version managed outside the repo (remote parent or imported BOM)"
          : !exact
            ? `version "${raw}" is not a literal version or a property defined in the repo`
            : undefined;
        const parsed = dependencyInstance.safeParse({
          ecosystem: "maven",
          name,
          version: exact,
          ...(d.version ? { declaredRange: d.version } : {}),
          direct: true,
          scope: scopeOf(d.scope, d.optional),
          workspace: mod.dir,
          manifestPath: mod.manifest,
          source: "registry",
          resolvedBy: exact ? "toolchain" : "unresolved",
          ...(reason ? { unresolvedReason: reason } : {}),
        });
        if (parsed.success) instances.push(parsed.data);
      }
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

/** `include(":app", ":lib")`, `include ':app'`, `include("app")` → Gradle project paths. */
export function gradleIncludes(settings: string) {
  const out: string[] = [];
  for (const m of settings.matchAll(/^\s*include\s*\(?([^\n)]*)\)?/gm))
    for (const p of (m[1] ?? "").matchAll(/["']([^"']+)["']/g))
      out.push(p[1]?.startsWith(":") ? (p[1] as string) : `:${p[1]}`);
  return out;
}

interface Catalog {
  versions: Record<string, string>;
  /** Accessor (`okhttp.logging`) → { module, version | null, ref }. */
  libraries: Map<string, { module: string; version: string | null; ref: string | null; key: string }>;
}

export function readCatalog(text: string): Catalog {
  const doc = parseToml(text) as {
    versions?: Record<string, unknown>;
    libraries?: Record<string, unknown>;
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
  return { versions, libraries };
}

const GRADLE_CONFIG =
  /\b(api|implementation|compileOnly|runtimeOnly|testImplementation|testCompileOnly|testRuntimeOnly|androidTestImplementation|kapt|ksp|annotationProcessor)\b\s*\(?\s*(?:platform\s*\(\s*)?(?:"([^"$]+)"|'([^'$]+)'|(libs\.[\w.]+))/g;

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
      (f) =>
        /(?:^|\/)settings\.gradle(?:\.kts)?$/.test(f) &&
        !/(?:^|\/)(?:buildSrc|build-logic|node_modules)\//.test(f),
    );
  const roots = settingsFiles.length
    ? settingsFiles.map((s) => ({ root: dirname(s), settings: s }))
    : tree
        .files()
        .filter((f) => /^build\.gradle(?:\.kts)?$/.test(f))
        .map((f) => ({ root: ".", settings: f }));
  const projects: JvmProject[] = [];
  for (const { root, settings } of roots) {
    const at = (p: string) => (root === "." ? p : join(root, p));
    const settingsText = tree.read(settings) ?? "";
    const projectPaths = [":", ...gradleIncludes(settingsText)];
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
    for (const p of projectPaths) {
      const dir = p === ":" ? root : at(p.slice(1).replace(/:/g, "/"));
      const manifest = [join(dir, "build.gradle.kts"), join(dir, "build.gradle")].find(
        (f) => tree.read(f) !== null,
      );
      if (!manifest) continue;
      const lockPath = join(dir, "gradle.lockfile");
      const lockText = tree.read(lockPath);
      modules.push({ name: p, dir, manifest, lockfile: lockText !== null ? lockPath : null });
      const text = tree.read(manifest) ?? "";
      const locked = lockText !== null ? parseGradleLockfile(lockText) : null;
      const declared = new Map<string, { version: string | null; config: string; declaredAs: string }>();
      for (const m of text.matchAll(GRADLE_CONFIG)) {
        const config = m[1] as string;
        const notation = m[2] ?? m[3];
        if (notation) {
          const [g, a, v] = notation.split(":");
          if (g && a) declared.set(`${g}:${a}`, { version: v ?? null, config, declaredAs: notation });
        } else if (m[4] && catalog) {
          const lib = catalog.libraries.get(m[4].slice(5));
          if (lib) declared.set(lib.module, { version: lib.version, config, declaredAs: m[4] });
        }
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
        const test = /^test|androidTest/.test(d.config);
        const fromLock = locked ? (lockedVersion(name, test) ?? lockedVersion(name, !test)) : null;
        const literal = d.version && VERSION.test(d.version) ? d.version : null;
        const version = fromLock ?? literal;
        const parsed = dependencyInstance.safeParse({
          ecosystem: "maven",
          name,
          version,
          ...(d.version ? { declaredRange: d.version } : {}),
          direct: true,
          scope: test
            ? "test"
            : d.config === "compileOnly"
              ? "build"
              : /kapt|ksp|annotationProcessor/.test(d.config)
                ? "build"
                : "prod",
          workspace: p,
          manifestPath: manifest,
          ...(locked ? { lockfilePath: lockPath } : {}),
          source: "registry",
          resolvedBy: fromLock ? "lockfile" : literal ? "toolchain" : "unresolved",
          ...(!version
            ? {
                unresolvedReason: d.version
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
    if (!modules.some((m) => m.lockfile))
      notes.push("no gradle.lockfile: declared versions are the floor (conflict resolution can raise them)");
    projects.push({
      root,
      manager: "gradle",
      manifest: modules[0]?.manifest ?? settings,
      lockfile: modules.find((m) => m.lockfile)?.lockfile ?? null,
      modules,
      instances,
      wrapper: tree.read(at("gradlew")) !== null,
      catalog: catalogText !== null ? catalogPath : null,
      notes,
    });
  }
  return projects;
}

export function readJvmInventory(tree: RepoTree): JvmProject[] {
  return [...readMaven(tree), ...readGradle(tree)];
}
