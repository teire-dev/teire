import { join } from "node:path";
import { VERIFY } from "../constants";
import type { JvmProject } from "../inventory/jvm";
import type { RepoTree } from "../inventory/tree";
import { ciJobsFor } from "./ci";
import type { CheckPlan, PlannedCheck } from "./commands";

/**
 * What to run for a Maven or Gradle build (plan S08, research jvm.md Job 8). The install phase is
 * `teire-jvm warmup` (sandbox image): the repo's real build online with failures ignored, so every
 * plugin, test provider and dependency the checks need is downloaded even when the upgraded code
 * does not compile yet (`dependency:go-offline` misses surefire's provider; Gradle resolves test
 * runtime dependencies only when tests run). It fails only on dependency resolution. Checks then
 * run offline (`mvn -o`, `gradle --offline`) with the same phases. The JDK comes from CI
 * (`actions/setup-java`), `.java-version`/`.sdkmanrc`/`.tool-versions`, the Gradle toolchain or
 * the Maven compiler release; the image carries 17, 21 and 25 and fetches others in the install.
 */
const JDKS_IN_IMAGE = ["17", "21", "25"];

function ciJava(tree: RepoTree, root: string) {
  // The jobs that build this project (a monorepo's folder job), not every workflow's.
  for (const job of ciJobsFor(tree, root))
    for (const step of job.steps) {
      if (!step.uses?.startsWith("actions/setup-java")) continue;
      const v = String(step.with?.["java-version"] ?? "");
      const matrix = /\$\{\{\s*matrix\.(\w+)\s*\}\}/.exec(v)?.[1];
      const values = matrix ? (job.strategy?.matrix?.[matrix] as unknown[] | undefined) : undefined;
      // A matrix: the highest JDK it tests, which is the one most likely to be current.
      const pick = values?.length ? String(values.map(String).sort((a, b) => Number(b) - Number(a))[0]) : v;
      const major = /^(\d+)/.exec(pick)?.[1];
      if (major) return major;
      const file = step.with?.["java-version-file"];
      if (typeof file === "string") {
        const text = tree.read(file)?.trim();
        const m = text && /(\d+)/.exec(text)?.[1];
        if (m) return m;
      }
    }
  return null;
}

/** The JDK the build expects, and where the answer came from. */
export function javaVersionFor(tree: RepoTree, project: JvmProject): { major: string; source: string } {
  const ci = ciJava(tree, project.root);
  if (ci) return { major: ci, source: "CI setup-java" };
  const at = (p: string) => (project.root === "." ? p : join(project.root, p));
  const file = tree.read(at(".java-version")) ?? tree.read(".java-version");
  const fromFile = file && /^(?:1\.)?(\d+)/.exec(file.trim())?.[1];
  if (fromFile) return { major: fromFile, source: ".java-version" };
  const sdkman = /^java=(\d+)/m.exec(tree.read(at(".sdkmanrc")) ?? "")?.[1];
  if (sdkman) return { major: sdkman, source: ".sdkmanrc" };
  const tools = /^java\s+\S*?(\d+)/m.exec(tree.read(at(".tool-versions")) ?? "")?.[1];
  if (tools) return { major: tools, source: ".tool-versions" };
  for (const m of project.modules) {
    const text = tree.read(m.manifest) ?? "";
    const toolchain =
      /languageVersion\s*(?:=|\.set\()\s*JavaLanguageVersion\.of\(\s*(\d+)/.exec(text)?.[1] ??
      /jvmToolchain\(\s*(\d+)/.exec(text)?.[1] ??
      /<maven\.compiler\.(?:release|target|source)>(?:1\.)?(\d+)</.exec(text)?.[1] ??
      /<release>(\d+)<\/release>/.exec(text)?.[1];
    if (toolchain)
      return {
        major: toolchain,
        source: `${m.manifest} (${project.manager === "maven" ? "compiler release" : "toolchain"})`,
      };
  }
  return { major: "21", source: "default (no JDK named)" };
}

export function detectJvmChecks(tree: RepoTree, project: JvmProject, sandboxRoot = "/work"): CheckPlan {
  const notes = [...project.notes];
  const jdk = javaVersionFor(tree, project);
  // Gradle 9 itself needs 17+; an older toolchain compiles through the toolchain, not the daemon.
  const javaHome = `/opt/jdk/${jdk.major}`;
  notes.push(
    `JDK ${jdk.major} (${jdk.source})${JDKS_IN_IMAGE.includes(jdk.major) ? "" : ", fetched during the install"}`,
  );
  const env = {
    JAVA_HOME: javaHome,
    TEIRE_JDK: jdk.major,
    MAVEN_OPTS: "-Xmx1536m",
    GRADLE_OPTS: "-Xmx1536m -Dorg.gradle.daemon=false",
    // Every installed JDK is visible to Gradle toolchains; nothing is downloaded at check time.
    ORG_GRADLE_PROJECT_org_gradle_java_installations_auto_download: "false",
  };
  const checks: PlannedCheck[] =
    project.manager === "maven"
      ? [
          { name: "typecheck", argv: ["teire-jvm", "maven", "-o", "test-compile"], source: "default" },
          { name: "test", argv: ["teire-jvm", "maven", "-o", "verify"], source: "default" },
        ]
      : [
          { name: "typecheck", argv: ["teire-jvm", "gradle", "--offline", "testClasses"], source: "default" },
          {
            name: "test",
            argv: ["teire-jvm", "gradle", "--offline", "--continue", "test"],
            source: "default",
          },
        ];
  return {
    manager: project.manager,
    image: "jvm",
    instance: "standard-3",
    cwd: project.root === "." ? sandboxRoot : join(sandboxRoot, project.root),
    install: ["teire-jvm", "warmup", project.manager],
    installEnv: env,
    installTimeoutSec: VERIFY.jvmInstallTimeoutSec,
    env,
    checks,
    provenOffline: true,
    // Maven fetches surefire's provider only when tests run; upgraded code that does not compile yet
    // runs none, so the unchanged repo warms the cache first (research jvm.md Job 8).
    warmBeforeChange: true,
    notes,
  };
}
