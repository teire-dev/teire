import { dirname, join, normalize } from "node:path";
import { VERIFY } from "../constants";
import type { DependencyInstance } from "../contract";
import { type JvmProject, MAVEN_PLUGIN_GROUP } from "../inventory/jvm";
import type { RepoTree } from "../inventory/tree";
import type { Transaction } from "./transaction";
import type { ManifestEdit } from "./upgrade-js";

/**
 * The JVM upgrade transaction (plan S08, research jvm.md Job 7). Edits are offset-preserving text
 * splices in the worker, so comments and layout stay (TOML and XML writers would reformat):
 *  - Maven: the dependency's literal `<version>`, else the `${property}` it uses (this POM or a
 *    local parent), else the local `dependencyManagement` entry. Maven has no lockfile; the
 *    sandbox's warm-up resolves the new graph.
 *  - Gradle: `"g:a:v"` strings in build files, the catalog's `[versions]` entry (`version.ref`, which
 *    moves every library sharing it, as intended), an inline catalog version, or a
 *    `gradle.properties` variable; then `--update-locks g:a` in the sandbox for every project with a
 *    `gradle.lockfile`, which moves only that module and what it newly needs.
 */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type BlockTag = "dependency" | "parent" | "plugin" | "extension";

/**
 * The `<dependency>` (or `<parent>`, `<plugin>`, `<extension>`, S18.3) blocks naming g:a, with their
 * offsets. A plugin's own dependencies, executions and configuration are blanked before matching, so
 * their coordinates and versions are never taken for the plugin's; a plugin naming no group is in
 * Maven's default one.
 */
function dependencyBlocks(xml: string, group: string, artifact: string, tag: BlockTag = "dependency") {
  const out: { start: number; end: number; text: string }[] = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "g"))) {
    const text = m[0];
    const own = mask(text, [
      /<dependencies>[\s\S]*?<\/dependencies>/g,
      /<executions>[\s\S]*?<\/executions>/g,
      /<configuration>[\s\S]*?<\/configuration>/g,
      /<!--[\s\S]*?-->/g,
    ]);
    const groupId =
      /<groupId>\s*([^<]*?)\s*<\/groupId>/.exec(own)?.[1] ?? (tag === "plugin" ? MAVEN_PLUGIN_GROUP : null);
    if (groupId === group && new RegExp(`<artifactId>\\s*${esc(artifact)}\\s*</artifactId>`).test(own))
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + text.length, text: own });
  }
  return out;
}

const blockTag = (instance: DependencyInstance): BlockTag =>
  instance.role === "parent" || instance.role === "plugin" || instance.role === "extension"
    ? instance.role
    : "dependency";

function setProperty(xml: string, prop: string, value: string) {
  const re = new RegExp(`(<properties>[\\s\\S]*?<${esc(prop)}>)\\s*([^<]*?)\\s*(</${esc(prop)}>)`);
  const m = re.exec(xml);
  return m ? { text: xml.replace(re, `$1${value}$3`), from: m[2] ?? "" } : null;
}

/** POM paths from `path` up its local parent chain. */
function pomChain(tree: RepoTree, path: string) {
  const chain = [path];
  for (let i = 0; i < 10; i++) {
    const text = tree.read(chain[chain.length - 1] as string) ?? "";
    const parent = /<parent>([\s\S]*?)<\/parent>/.exec(text)?.[1];
    if (!parent) break;
    const rel = /<relativePath>\s*([^<]*?)\s*<\/relativePath>/.exec(parent)?.[1] ?? "../pom.xml";
    if (rel === "") break;
    const next = normalize(
      join(dirname(chain[chain.length - 1] as string), rel.endsWith(".xml") ? rel : join(rel, "pom.xml")),
    );
    if (tree.read(next) === null || chain.includes(next)) break;
    chain.push(next);
  }
  return chain;
}

export function mavenEdit(
  tree: RepoTree,
  project: JvmProject,
  instance: DependencyInstance,
  target: string,
): ManifestEdit | null {
  const [group, artifact] = instance.name.split(":") as [string, string];
  const chain = pomChain(tree, instance.manifestPath);
  const editVersion = (
    path: string,
    raw: string,
    block: { start: number; end: number; text: string },
  ): ManifestEdit | null => {
    const before = tree.read(path) as string;
    const prop = /^\$\{([^}]+)\}$/.exec(raw.trim())?.[1];
    if (!prop) {
      // The version element's offset in the masked block is its offset in the file's.
      const at = /<version>\s*[^<]*?\s*<\/version>/.exec(block.text);
      if (!at) return null;
      const start = block.start + at.index;
      const end = start + at[0].length;
      return {
        path,
        before,
        after: `${before.slice(0, start)}<version>${target}</version>${before.slice(end)}`,
        from: raw.trim(),
        to: target,
      };
    }
    // The property lives in this POM or a parent in the repo; the first that defines it wins.
    for (const p of pomChain(tree, path)) {
      const text = tree.read(p) as string;
      const set = setProperty(text, prop, target);
      if (set) return { path: p, before: text, after: set.text, from: `${prop} ${set.from}`, to: target };
    }
    return null;
  };
  const tag = blockTag(instance);
  for (const path of chain) {
    const xml = tree.read(path) ?? "";
    for (const block of dependencyBlocks(xml, group, artifact, tag)) {
      const raw = /<version>\s*([^<]*?)\s*<\/version>/.exec(block.text)?.[1];
      if (raw) return editVersion(path, raw, block);
    }
  }
  // Managed: the version sits in a local dependencyManagement (pluginManagement) section.
  const section = tag === "plugin" ? "pluginManagement" : "dependencyManagement";
  for (const path of [...chain, project.manifest]) {
    const xml = tree.read(path) ?? "";
    const managed = new RegExp(`<${section}>[\\s\\S]*?<\\/${section}>`).exec(xml);
    if (!managed) continue;
    for (const block of dependencyBlocks(managed[0], group, artifact, tag)) {
      const raw = /<version>\s*([^<]*?)\s*<\/version>/.exec(block.text)?.[1];
      const offset = managed.index ?? 0;
      if (raw)
        return editVersion(path, raw, { ...block, start: block.start + offset, end: block.end + offset });
    }
  }
  return null;
}

export function gradleEdits(
  tree: RepoTree,
  project: JvmProject,
  instance: DependencyInstance,
  target: string,
): ManifestEdit[] {
  const [group, artifact] = instance.name.split(":") as [string, string];
  const ga = `${esc(group)}:${esc(artifact)}`;
  const edits: ManifestEdit[] = [];
  const from = instance.version ?? instance.declaredRange ?? "";
  // A plugin (its marker `id:id.gradle.plugin`): the plugins-block line, or its catalog entry.
  if (artifact === `${group}.gradle.plugin`) {
    const id = esc(group);
    for (const m of project.modules) {
      const before = tree.read(m.manifest);
      if (before === null) continue;
      const after = before.replace(
        new RegExp(`(\\bid\\s*\\(?\\s*["']${id}["']\\s*\\)?\\s+version\\s*\\(?\\s*["'])[^"'$]+(["'])`, "g"),
        `$1${target}$2`,
      );
      if (after !== before) edits.push({ path: m.manifest, before, after, from, to: target });
    }
    if (project.catalog) {
      const before = tree.read(project.catalog) ?? "";
      const entry = new RegExp(`^.*id\\s*=\\s*"${id}".*$`, "m").exec(before)?.[0];
      const ref = entry ? /version\.ref\s*=\s*"([^"]+)"/.exec(entry)?.[1] : undefined;
      const after = !entry
        ? before
        : ref
          ? before.replace(
              new RegExp(`(\\[versions\\][\\s\\S]*?^\\s*${esc(ref)}\\s*=\\s*)"[^"]*"`, "m"),
              `$1"${target}"`,
            )
          : before.replace(entry, entry.replace(/(version\s*=\s*)"[^"]*"/, `$1"${target}"`));
      if (after !== before) edits.push({ path: project.catalog, before, after, from, to: target });
    }
    return edits;
  }
  // `"g:a:v"` strings and map notation (`group: "g", name: "a", version: "v"`, S18.3) in any build
  // file of the project, and the variables `"g:a:$var"` or `version: "$var"` name.
  const variables = new Set<string>();
  const mapped = new RegExp(
    `(group\\s*[:=]\\s*["']${esc(group)}["']\\s*,\\s*name\\s*[:=]\\s*["']${esc(artifact)}["']\\s*,\\s*version\\s*[:=]\\s*["'])([^"']+)(["'])`,
    "g",
  );
  const pending = new Map<string, string>();
  for (const m of project.modules) {
    const before = pending.get(m.manifest) ?? tree.read(m.manifest);
    if (before === null) continue;
    for (const v of before.matchAll(new RegExp(`["']${ga}:\\$\\{?(\\w+)\\}?["']`, "g")))
      if (v[1]) variables.add(v[1]);
    for (const v of before.matchAll(mapped)) {
      const name = /^\$\{?(\w+)\}?$/.exec(v[2] ?? "")?.[1];
      if (name) variables.add(name);
    }
    const after = before
      .replace(new RegExp(`(["'])(${ga}):([0-9][^"'$:]*)\\1`, "g"), `$1$2:${target}$1`)
      .replace(mapped, (all, head: string, version: string, tail: string) =>
        version.startsWith("$") ? all : `${head}${target}${tail}`,
      );
    pending.set(m.manifest, after);
  }
  // A variable defined in a build file: `val x = "…"`, `def x = '…'`, `ext.x = …`, an `ext { }`
  // block, `extra["x"] = …`, `val x by extra("…")`, `set("x", …)`.
  for (const v of variables) {
    const name = esc(v);
    const definitions = [
      new RegExp(
        `(^\\s*(?:val|var|def|String)\\s+${name}\\s*(?::\\s*String\\s*)?=\\s*["'])[^"'$\\n]+(["'])`,
        "m",
      ),
      new RegExp(`(\\bext\\.${name}\\s*=\\s*["'])[^"'$\\n]+(["'])`),
      new RegExp(`(\\bextra\\[\\s*["']${name}["']\\s*\\]\\s*=\\s*["'])[^"'$\\n]+(["'])`),
      new RegExp(`(\\bval\\s+${name}\\s+by\\s+extra\\(\\s*["'])[^"'$\\n]+(["'])`),
      new RegExp(`(\\bset\\(\\s*["']${name}["']\\s*,\\s*["'])[^"'$\\n]+(["'])`),
      new RegExp(`(\\bext\\s*\\{[^}]*?^\\s*${name}\\s*=\\s*["'])[^"'$\\n]+(["'])`, "m"),
    ];
    for (const [path, text] of pending) {
      const re = definitions.find((d) => d.test(text));
      if (re) pending.set(path, text.replace(re, `$1${target}$2`));
    }
  }
  for (const [path, after] of pending) {
    const before = tree.read(path) ?? "";
    if (after !== before) edits.push({ path, before, after, from, to: target });
  }
  if (project.catalog) {
    const before = tree.read(project.catalog) ?? "";
    let after = before;
    // The library entry: `x = { module = "g:a", version.ref = "k" }`, inline `version = "v"`, or `"g:a:v"`.
    const entry = new RegExp(
      `^.*(?:module\\s*=\\s*"${ga}"|group\\s*=\\s*"${esc(group)}"\\s*,\\s*name\\s*=\\s*"${esc(artifact)}"|"${ga}:[^"]+").*$`,
      "m",
    ).exec(before)?.[0];
    if (entry) {
      const ref =
        /version\.ref\s*=\s*"([^"]+)"/.exec(entry)?.[1] ??
        /version\s*=\s*\{\s*ref\s*=\s*"([^"]+)"/.exec(entry)?.[1];
      if (ref)
        after = after.replace(
          new RegExp(`(\\[versions\\][\\s\\S]*?^\\s*${esc(ref)}\\s*=\\s*)"[^"]*"`, "m"),
          `$1"${target}"`,
        );
      else {
        const updated = entry
          .replace(/(version\s*=\s*)"[^"]*"/, `$1"${target}"`)
          .replace(new RegExp(`"(${ga}):[^"]+"`), `"$1:${target}"`);
        after = after.replace(entry, updated);
      }
    }
    if (after !== before) edits.push({ path: project.catalog, before, after, from, to: target });
  }
  const props = project.root === "." ? "gradle.properties" : join(project.root, "gradle.properties");
  const propsText = tree.read(props);
  if (propsText !== null && variables.size) {
    let after = propsText;
    for (const v of variables)
      after = after.replace(new RegExp(`^(\\s*${esc(v)}\\s*=\\s*).*$`, "m"), `$1${target}`);
    if (after !== propsText) edits.push({ path: props, before: propsText, after, from, to: target });
  }
  return edits;
}

/**
 * The toolchain co-upgrade (S15.10): every Java declaration below `floor` in the project's build
 * files raised to it (Gradle `sourceCompatibility`/`targetCompatibility`, `JavaVersion.VERSION_n`,
 * `JavaLanguageVersion.of(n)`; Maven `maven.compiler.release|source|target` and `java.version`),
 * applied on top of the version edits already planned for the same file.
 */
export function withJavaFloor(
  tree: RepoTree,
  project: JvmProject,
  edits: ManifestEdit[],
  floor: number,
  why: string,
): ManifestEdit[] {
  const raise = (text: string) =>
    text
      .replace(
        /((?:source|target)Compatibility\s*=\s*['"]?)(?:1\.)?(\d+)(['"]?)/g,
        (m, a: string, n: string, b: string) => (Number(n) < floor ? `${a}${floor}${b}` : m),
      )
      .replace(/(JavaVersion\.VERSION_)(?:1_)?(\d+)/g, (m, a: string, n: string) =>
        Number(n) < floor ? `${a}${floor}` : m,
      )
      .replace(/(JavaLanguageVersion\.of\(\s*)(\d+)(\s*\))/g, (m, a: string, n: string, b: string) =>
        Number(n) < floor ? `${a}${floor}${b}` : m,
      )
      .replace(
        /(<(maven\.compiler\.(?:release|source|target)|java\.version)>\s*)(?:1\.)?(\d+)(\s*<\/\2>)/g,
        (m, a: string, _tag: string, n: string, b: string) => (Number(n) < floor ? `${a}${floor}${b}` : m),
      );
  const out = edits.map((e) => ({ ...e }));
  const files = new Set([...project.modules.map((m) => m.manifest), project.manifest]);
  for (const path of files) {
    const existing = out.find((e) => e.path === path);
    const base = existing?.after ?? tree.read(path);
    if (base === null || base === undefined) continue;
    const after = raise(base);
    if (after === base) continue;
    const note = `Java ${floor}: ${why}`;
    if (existing) {
      existing.after = after;
      existing.note = `\`${existing.from}\` → \`${existing.to}\`; ${note}`;
    } else out.push({ path, before: base, after, from: "", to: `Java ${floor}`, note });
  }
  return out;
}

/**
 * A transitive fix on Gradle (S15.7): a dependency constraint in the module's build file. A
 * constraint takes part in conflict resolution, so the locked version rises to the fix even where
 * the packages that pull it in ask for less; Gradle's own way to raise a version you don't declare.
 */
export function gradleConstraintEdit(
  tree: RepoTree,
  path: string,
  instance: DependencyInstance,
  target: string,
  because: string,
): ManifestEdit | null {
  const before = tree.read(path);
  if (before === null) return null;
  const q = (s: string) => (path.endsWith(".kts") ? `"${s}"` : `'${s}'`);
  const indent = /^( +|\t)\S/m.exec(before)?.[1] ?? "    ";
  const configuration = instance.scope === "test" ? "testImplementation" : "implementation";
  const block = [
    "dependencies {",
    `${indent}constraints {`,
    `${indent.repeat(2)}${configuration}(${q(`${instance.name}:${target}`)}) {`,
    `${indent.repeat(3)}because(${q(because.replace(/['"\\$]/g, ""))})`,
    `${indent.repeat(2)}}`,
    `${indent}}`,
    "}",
  ].join("\n");
  return {
    path,
    before,
    after: `${before.replace(/\n*$/, "\n")}\n${block}\n`,
    from: instance.version ?? "",
    to: target,
    note: `a dependency constraint raises \`${instance.name}\` to ${target}: the packages that depend on it ask for less`,
  };
}

/**
 * A transitive fix on Maven (S15.7, review R14): a `<dependencyManagement>` entry in the root POM.
 * Managed versions win Maven's mediation for transitive dependencies, so the fix is used even
 * where the packages that pull it in ask for less. An existing managed entry is moved instead.
 */
export function mavenManagedPin(
  tree: RepoTree,
  project: JvmProject,
  name: string,
  target: string,
): ManifestEdit | null {
  // The root POM governs the whole build; a child module's would pin only that module.
  const rootPom = project.root === "." ? "pom.xml" : `${project.root}/pom.xml`;
  const path = tree.read(rootPom) !== null ? rootPom : project.manifest;
  const before = tree.read(path);
  if (before === null) return null;
  const [group = "", artifact = ""] = name.split(":");
  const indent = /\n([ \t]+)<(?:dependencies|properties|modelVersion)>/.exec(before)?.[1] ?? "  ";
  const entry = (pad: string) =>
    `${pad}<dependency>\n${pad}${indent}<groupId>${group}</groupId>\n${pad}${indent}<artifactId>${artifact}</artifactId>\n${pad}${indent}<version>${target}</version>\n${pad}</dependency>`;
  // The project's own sections, found in a copy where comments, profiles and the build section are
  // blanked to the same length (round 2: at any indent, never a profile's, which pins only when that
  // profile is active).
  const own = mask(before, [
    /<!--[\s\S]*?-->/g,
    /<profiles>[\s\S]*?<\/profiles>/g,
    /<build>[\s\S]*?<\/build>/g,
  ]);
  const managed =
    /<dependencyManagement>\s*<dependencies>([\s\S]*?)<\/dependencies>\s*<\/dependencyManagement>/.exec(own);
  let after: string;
  if (managed) {
    const bodyStart = managed.index + managed[0].indexOf("<dependencies>") + "<dependencies>".length;
    const bodyEnd = bodyStart + (managed[1] ?? "").length;
    const body = before.slice(bodyStart, bodyEnd);
    // Each managed `<dependency>`, whatever the order of its elements (scope, type and exclusions
    // may sit between them): the one for this package gets the target as its version.
    let moved = false;
    const replaced = body.replace(/<dependency>[\s\S]*?<\/dependency>/g, (dep) => {
      const tag = (t: string) => new RegExp(`<${t}>\\s*([^<]*?)\\s*</${t}>`).exec(dep)?.[1];
      if (moved || tag("groupId") !== group || tag("artifactId") !== artifact) return dep;
      moved = true;
      return /<version>[^<]*<\/version>/.test(dep)
        ? dep.replace(/<version>[^<]*<\/version>/, `<version>${target}</version>`)
        : dep.replace(/(\s*)<\/dependency>$/, `$1${indent}<version>${target}</version>$1</dependency>`);
    });
    const next = moved ? replaced : body.replace(/(\n?)([ \t]*)$/, `\n${entry(indent.repeat(3))}$1$2`);
    after = before.slice(0, bodyStart) + next + before.slice(bodyEnd);
  } else {
    const section = `${indent}<dependencyManagement>\n${indent.repeat(2)}<dependencies>\n${entry(indent.repeat(3))}\n${indent.repeat(2)}</dependencies>\n${indent}</dependencyManagement>\n`;
    // Before the project's own `<dependencies>`, not a plugin's or a profile's.
    const deps = /\n[ \t]*<dependencies>/.exec(own);
    after = deps
      ? `${before.slice(0, deps.index + 1)}${section}${before.slice(deps.index + 1)}`
      : before.replace(/<\/project>\s*$/, `${section}</project>\n`);
  }
  return after === before
    ? null
    : {
        path,
        before,
        after,
        from: "",
        to: target,
        note: `\`<dependencyManagement>\` pins \`${name}\` to ${target}: the packages that depend on it ask for less`,
      };
}

/**
 * Defines (or moves) `<prop>` in a POM's own `<properties>` (D-28): a property the remote parent
 * defines is overridden by the child, and everything the parent manages with it moves with it.
 */
export function mavenPropertyOverride(
  tree: RepoTree,
  path: string,
  prop: string,
  target: string,
): ManifestEdit | null {
  const before = tree.read(path);
  if (before === null) return null;
  const moved = setProperty(before, prop, target);
  if (moved) return { path, before, after: moved.text, from: `${prop} ${moved.from}`, to: target };
  const indent = /\n([ \t]+)<(?:dependencies|properties|modelVersion)>/.exec(before)?.[1] ?? "  ";
  const own = mask(before, [
    /<!--[\s\S]*?-->/g,
    /<profiles>[\s\S]*?<\/profiles>/g,
    /<build>[\s\S]*?<\/build>/g,
  ]);
  const props = /\n([ \t]*)<\/properties>/.exec(own);
  const line = `${indent}${indent}<${prop}>${target}</${prop}>\n`;
  const after = props
    ? `${before.slice(0, props.index + 1)}${line}${before.slice(props.index + 1)}`
    : (() => {
        const section = `${indent}<properties>\n${line}${indent}</properties>\n`;
        const deps = /\n[ \t]*<dependencies>/.exec(own);
        return deps
          ? `${before.slice(0, deps.index + 1)}${section}${before.slice(deps.index + 1)}`
          : before.replace(/<\/project>\s*$/, `${section}</project>\n`);
      })();
  return {
    path,
    before,
    after,
    from: "",
    to: target,
    note: `\`<${prop}>\` set to ${target} here, over the parent's`,
  };
}

/** `text` with every match of `patterns` replaced by spaces of the same length (offsets stay valid). */
function mask(text: string, patterns: RegExp[]) {
  return patterns.reduce((out, re) => out.replace(re, (m) => m.replace(/[^\n]/g, " ")), text);
}

/**
 * The version Maven resolves for a managed transitive pin, checked in the sandbox (review R14,
 * round 2): the edit being in the POM is not proof the build uses it. `dependency:tree` names
 * `group:artifact:type[:classifier]:version:scope`; the transaction fails unless it shows the target.
 */
export function mavenResolvedCheck(name: string, target: string): string[] | null {
  const [group = "", artifact = ""] = name.split(":");
  const coordinate = /^[\w.-]+$/;
  if (!coordinate.test(group) || !coordinate.test(artifact) || !/^[\w.+-]+$/.test(target)) return null;
  const esc = (s: string) => s.replace(/\./g, "\\.");
  return [
    "sh",
    "-c",
    `rm -f /tmp/teire-tree.txt && teire-jvm maven -q dependency:tree -Dincludes=${group}:${artifact} -DoutputFile=/tmp/teire-tree.txt -DappendOutput=true && grep -Eq '${esc(group)}:${esc(artifact)}:[^:]+:([^:]+:)?${esc(target)}(:|$)' /tmp/teire-tree.txt || { echo "Maven resolves ${group}:${artifact} to:"; grep -Eh '${esc(group)}:${esc(artifact)}:' /tmp/teire-tree.txt; exit 1; }`,
  ];
}

export function jvmTransaction(
  tree: RepoTree,
  project: JvmProject,
  instance: DependencyInstance,
  target: string,
  javaFloor?: { version: number; why: string },
  because = `fixes a security advisory in ${instance.name}`,
): Transaction {
  if (project.manager === "maven") {
    // A version managed outside the repo (D-28) is pinned locally: a local managed entry wins over a
    // parent's, so only this package moves.
    // A `${prop}` the parent defines is overridden by defining it here (Spring Boot's documented way).
    const property = instance.managedBy
      ? /^\$\{([^}]+)\}$/.exec(instance.declaredRange?.trim() ?? "")?.[1]
      : null;
    const versionEdit = property
      ? mavenPropertyOverride(tree, instance.manifestPath, property, target)
      : instance.direct && !instance.managedBy
        ? mavenEdit(tree, project, instance, target)
        : mavenManagedPin(tree, project, instance.name, target);
    const withJava = javaFloor
      ? withJavaFloor(tree, project, versionEdit ? [versionEdit] : [], javaFloor.version, javaFloor.why)
      : versionEdit
        ? [versionEdit]
        : [];
    const edit = withJava.find((e) => e.path === versionEdit?.path) ?? null;
    const readBack = withJava.length ? [...new Set(withJava.map((e) => e.path))] : [instance.manifestPath];
    const resolved =
      (!instance.direct || instance.managedBy) && edit ? mavenResolvedCheck(instance.name, target) : null;
    return {
      describe: edit
        ? `${edit.path}: ${instance.name} ${edit.from} → ${target}${javaFloor && withJava.length > (versionEdit ? 1 : 0) ? `; Java raised to ${javaFloor.version}` : ""} (Maven has no lockfile; the sandbox resolves the new graph)`
        : `${instance.name}: version not declared in the repo's POMs`,
      manifest: withJava,
      commands: resolved ? [resolved] : [],
      readBack,
      check: (files) =>
        edit && (files[edit.path] ?? "").includes(target)
          ? null
          : `${instance.name} ${target} is not declared in ${readBack[0]}`,
    };
  }
  const locked = project.modules.filter((m) => m.lockfile);
  // The modules whose locks hold the package: each must lock the target afterwards.
  const listed = new RegExp(`^${instance.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m");
  const holders = locked.filter((m) => listed.test(tree.read(m.lockfile as string) ?? ""));
  // A transitive package gets a constraint in each module that locks it (one module: its own file).
  const versionEdits = instance.direct
    ? gradleEdits(tree, project, instance, target)
    : (holders.length ? holders.map((m) => m.manifest) : [instance.manifestPath])
        .map((path) => gradleConstraintEdit(tree, path, instance, target, because))
        .filter((e): e is ManifestEdit => !!e);
  const edits = javaFloor
    ? withJavaFloor(tree, project, versionEdits, javaFloor.version, javaFloor.why)
    : versionEdits;
  const readBack = [...new Set([...edits.map((e) => e.path), ...locked.map((m) => m.lockfile as string)])];
  const lockLine = `${instance.name}:${target}=`;
  return {
    describe: `${edits.map((e) => e.path).join(", ") || "no declaration found"}: ${instance.name} → ${target}${locked.length ? `; --update-locks ${instance.name} in ${locked.map((m) => m.name).join(", ")}` : ""}`,
    manifest: edits,
    commands: locked.length
      ? [["teire-jvm", "lock-gradle", instance.name, ...locked.map((m) => m.name)]]
      : [],
    readBack,
    ...(locked[0]?.lockfile ? { lockfilePath: locked[0].lockfile } : {}),
    check: (files) => {
      if (!edits.length) return `${instance.name} is not declared with a version Teire can edit`;
      const stale = (holders.length ? holders : locked).find(
        (m) => !(files[m.lockfile as string] ?? "").includes(lockLine),
      );
      return stale ? `${stale.lockfile} does not lock ${instance.name} ${target}` : null;
    },
  };
}

/**
 * Gradle targeted locks after the resolver (D104): dependabot-core's Gradle updater rewrites every
 * lock entry and hides failures, so Teire keeps its manifest edit, drops its lockfiles, and re-locks
 * only this coordinate (`--update-locks g:a`) in every locked module, then reads the locks back.
 */
export function withGradleLocks(
  tx: Transaction,
  project: JvmProject,
  name: string,
  target: string,
): Transaction {
  const locked = project.modules.filter((m) => m.lockfile);
  if (project.manager !== "gradle" || !locked.length) return tx;
  const lockfiles = new Set(locked.map((m) => m.lockfile as string));
  const lockLine = `${name}:${target}=`;
  return {
    ...tx,
    describe: `${tx.describe}; Teire re-locks only ${name} (--update-locks) in ${locked.map((m) => m.name).join(", ")}`,
    manifest: tx.manifest.filter((m) => !lockfiles.has(m.path)),
    ...(tx.writes ? { writes: tx.writes.filter((w) => !lockfiles.has(w.path)) } : {}),
    // In the project's own directory, so a job over several roots re-locks each where it lives.
    commands: [
      ...tx.commands,
      [
        "env",
        "-C",
        project.root === "." ? VERIFY.workDir : `${VERIFY.workDir}/${project.root}`,
        "teire-jvm",
        "lock-gradle",
        name,
        ...locked.map((m) => m.name),
      ],
    ],
    readBack: [...new Set([...tx.readBack, ...lockfiles])],
    lockfilePath: locked[0]?.lockfile as string,
    check: (files) => {
      const stale = locked.find((m) => !(files[m.lockfile as string] ?? "").includes(lockLine));
      return stale ? `${stale.lockfile} does not lock ${name} ${target}` : (tx.check?.(files) ?? null);
    },
  };
}
