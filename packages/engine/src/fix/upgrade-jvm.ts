import { dirname, join, normalize } from "node:path";
import { VERIFY } from "../constants";
import type { DependencyInstance } from "../contract";
import type { JvmProject } from "../inventory/jvm";
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

/** The `<dependency>` blocks naming g:a, with their offsets. */
function dependencyBlocks(xml: string, group: string, artifact: string) {
  const out: { start: number; end: number; text: string }[] = [];
  for (const m of xml.matchAll(/<dependency>[\s\S]*?<\/dependency>/g)) {
    const text = m[0];
    if (
      new RegExp(`<groupId>\\s*${esc(group)}\\s*</groupId>`).test(text) &&
      new RegExp(`<artifactId>\\s*${esc(artifact)}\\s*</artifactId>`).test(text)
    )
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + text.length, text });
  }
  return out;
}

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
      const text = block.text.replace(/(<version>)\s*[^<]*?\s*(<\/version>)/, `$1${target}$2`);
      return {
        path,
        before,
        after: before.slice(0, block.start) + text + before.slice(block.end),
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
  for (const path of chain) {
    const xml = tree.read(path) ?? "";
    for (const block of dependencyBlocks(xml, group, artifact)) {
      const raw = /<version>\s*([^<]*?)\s*<\/version>/.exec(block.text)?.[1];
      if (raw) return editVersion(path, raw, block);
    }
  }
  // Managed: the version sits in a local dependencyManagement section.
  for (const path of [...chain, project.manifest]) {
    const xml = tree.read(path) ?? "";
    const managed = /<dependencyManagement>[\s\S]*?<\/dependencyManagement>/.exec(xml);
    if (!managed) continue;
    for (const block of dependencyBlocks(managed[0], group, artifact)) {
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
  // `"g:a:v"` strings in any build file of the project, and `"g:a:$var"` variables.
  const variables = new Set<string>();
  for (const m of project.modules) {
    const before = tree.read(m.manifest);
    if (before === null) continue;
    const after = before.replace(new RegExp(`(["'])(${ga}):([0-9][^"'$:]*)\\1`, "g"), `$1$2:${target}$1`);
    for (const v of before.matchAll(new RegExp(`["']${ga}:\\$\\{?(\\w+)\\}?["']`, "g")))
      if (v[1]) variables.add(v[1]);
    if (after !== before) edits.push({ path: m.manifest, before, after, from, to: target });
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
  const path = project.manifest;
  const before = tree.read(path);
  if (before === null) return null;
  const [group = "", artifact = ""] = name.split(":");
  const indent = /\n([ \t]+)<(?:dependencies|properties|modelVersion)>/.exec(before)?.[1] ?? "  ";
  const entry = (pad: string) =>
    `${pad}<dependency>\n${pad}${indent}<groupId>${group}</groupId>\n${pad}${indent}<artifactId>${artifact}</artifactId>\n${pad}${indent}<version>${target}</version>\n${pad}</dependency>`;
  const managed =
    /<dependencyManagement>\s*<dependencies>([\s\S]*?)<\/dependencies>\s*<\/dependencyManagement>/.exec(
      before,
    );
  let after: string;
  if (managed) {
    const block = managed[0];
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const existing = new RegExp(
      `(<dependency>\\s*<groupId>${esc(group)}</groupId>\\s*<artifactId>${esc(artifact)}</artifactId>\\s*<version>)[^<]*(</version>)`,
    );
    const replaced = existing.test(block)
      ? block.replace(existing, `$1${target}$2`)
      : block.replace(/(\n?)([ \t]*)<\/dependencies>/, `\n${entry(indent.repeat(3))}$1$2</dependencies>`);
    after = before.replace(block, replaced);
  } else {
    const section = `${indent}<dependencyManagement>\n${indent.repeat(2)}<dependencies>\n${entry(indent.repeat(3))}\n${indent.repeat(2)}</dependencies>\n${indent}</dependencyManagement>\n`;
    // The project's own `<dependencies>` (at its first indent), not a plugin's or a profile's.
    const at = before.search(new RegExp(`\\n${indent}<dependencies>`));
    after =
      at >= 0
        ? `${before.slice(0, at + 1)}${section}${before.slice(at + 1)}`
        : before.replace(/<\/project>/, `${section}</project>`);
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

export function jvmTransaction(
  tree: RepoTree,
  project: JvmProject,
  instance: DependencyInstance,
  target: string,
  javaFloor?: { version: number; why: string },
  because = `fixes a security advisory in ${instance.name}`,
): Transaction {
  if (project.manager === "maven") {
    const versionEdit = instance.direct
      ? mavenEdit(tree, project, instance, target)
      : mavenManagedPin(tree, project, instance.name, target);
    const withJava = javaFloor
      ? withJavaFloor(tree, project, versionEdit ? [versionEdit] : [], javaFloor.version, javaFloor.why)
      : versionEdit
        ? [versionEdit]
        : [];
    const edit = withJava.find((e) => e.path === versionEdit?.path) ?? null;
    const readBack = withJava.length ? [...new Set(withJava.map((e) => e.path))] : [instance.manifestPath];
    return {
      describe: edit
        ? `${edit.path}: ${instance.name} ${edit.from} → ${target}${javaFloor && withJava.length > (versionEdit ? 1 : 0) ? `; Java raised to ${javaFloor.version}` : ""} (Maven has no lockfile; the sandbox resolves the new graph)`
        : `${instance.name}: version not declared in the repo's POMs`,
      manifest: withJava,
      commands: [],
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
