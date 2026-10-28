import { join } from "node:path";
import type { RubyProject } from "../inventory/ruby";
import type { RepoTree } from "../inventory/tree";
import { ciJobsFor } from "./ci";
import type { CheckPlan, PlannedCheck } from "./commands";
import { rubyFor } from "./toolchains";

/**
 * What to run for a Bundler project (plan S07, research ruby.md Job 8). The repo's CI says it best:
 * its test steps (`bundle exec rspec`, `bin/rails test`, `bundle exec rake`), its `services:`
 * (postgres, mysql, redis started on localhost in the sandbox), its plain env (`DATABASE_URL`,
 * `RAILS_ENV`, `BUNDLE_WITHOUT`; never secrets) and its database setup (`bin/rails db:prepare`).
 * Without CI: `.rspec`/spec → rspec, a Rails app → `bin/rails test`, else the Rakefile's default.
 * `teire-ruby install` (sandbox image) installs the gems online, starts the services and prepares
 * the database; checks then run offline with `BUNDLE_FROZEN=true`, so nothing rewrites the lockfile.
 */
type Job = {
  env?: Record<string, unknown>;
  services?: Record<string, { image?: string; env?: Record<string, unknown> }>;
  steps?: { run?: string; env?: Record<string, unknown> }[];
};

const TEST = /^(?:bundle exec |bin\/)?(?:rspec|rails test|rake(?: (?:test|spec|default))?)(?:\s|$)/;
const DB_SETUP =
  /(?:bin\/rails|bundle exec rails|bundle exec rake|bin\/rake|rake) (?:db:(?:prepare|setup|create|schema:load|migrate|test:prepare))/;
const SERVICE_OF: [RegExp, string][] = [
  [/postgres|postgis/i, "postgres"],
  [/mysql|mariadb/i, "mysql"],
  [/redis|valkey/i, "redis"],
];

function plainEnv(env: Record<string, unknown> | undefined) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    const value = String(v ?? "");
    // `${{ secrets.X }}` and other expressions are GitHub's; Teire never has them.
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || value.includes("${{")) continue;
    out[k] = value;
  }
  return out;
}

function fromCi(tree: RepoTree, root: string) {
  const found = {
    tests: [] as string[],
    setup: [] as string[],
    services: new Set<string>(),
    env: {} as Record<string, string>,
  };
  for (const job of ciJobsFor(tree, root) as unknown as Job[]) {
    const lines = (job.steps ?? []).flatMap((s) => (s.run ?? "").split("\n").map((l) => l.trim()));
    const tests = lines.filter((l) => TEST.test(l) && !/system|rubocop|standardrb|brakeman|audit/.test(l));
    if (!tests.length) continue;
    // The job that runs the tests: its services, env and database setup.
    for (const t of tests) if (!found.tests.includes(t)) found.tests.push(t);
    for (const l of lines.filter((l) => DB_SETUP.test(l))) if (!found.setup.includes(l)) found.setup.push(l);
    for (const [name, service] of Object.entries(job.services ?? {}))
      for (const [re, kind] of SERVICE_OF)
        if (re.test(`${name} ${service.image ?? ""}`)) found.services.add(kind);
    Object.assign(found.env, plainEnv(job.env));
    for (const s of job.steps ?? [])
      if (s.run && TEST.test(s.run.trim())) Object.assign(found.env, plainEnv(s.env));
  }
  if (root !== ".") found.tests = found.tests.filter((t) => !t.includes("cd ") || t.includes(root));
  return found;
}

function argvOf(command: string) {
  return command.split(/\s+/).filter(Boolean);
}

/** An exact Ruby pin: `.ruby-version`, the Gemfile's `ruby "3.3.6"`, else the lockfile's RUBY VERSION. */
function rubyPin(tree: RepoTree, project: RubyProject) {
  const gemfile = tree.read(project.manifest) ?? "";
  const directive = /^\s*ruby\s+["'](\d+\.\d+\.\d+)["']/m.exec(gemfile)?.[1];
  const pin = directive ?? project.rubyVersion;
  return pin && /^\d+\.\d+\.\d+$/.test(pin) ? pin : null;
}

export function detectRubyChecks(tree: RepoTree, project: RubyProject, sandboxRoot = "/work"): CheckPlan {
  const notes = [...project.notes];
  const root = project.root;
  const at = (p: string) => (root === "." ? p : join(root, p));
  const has = (p: string) => tree.read(at(p)) !== null;
  const rails = has("config/application.rb");
  const ci = fromCi(tree, root);
  const checks: PlannedCheck[] = [];

  const services = new Set(ci.services);
  const databaseYml = tree.read(at("config/database.yml")) ?? "";
  if (rails && /adapter:\s*postgres/.test(databaseYml)) services.add("postgres");
  if (rails && /adapter:\s*(?:mysql2|trilogy)/.test(databaseYml)) services.add("mysql");
  const lock = project.lockfile ? (tree.read(project.lockfile) ?? "") : "";
  if (/^ {4}(?:sidekiq|redis) \(/m.test(lock) && ci.services.has("redis")) services.add("redis");

  const test = ci.tests[0];
  if (test) {
    checks.push({ name: "test", argv: argvOf(test), source: "ci" });
    if (ci.tests.length > 1) notes.push(`CI also runs: ${ci.tests.slice(1).join("; ")}`);
  } else if (has(".rspec") || tree.files().some((f) => f.startsWith(at("spec/")) && f.endsWith("_spec.rb")))
    checks.push({ name: "test", argv: ["bundle", "exec", "rspec"], source: "default" });
  else if (rails) checks.push({ name: "test", argv: ["bin/rails", "test"], source: "default" });
  else if (has("Rakefile"))
    checks.push({ name: "test", argv: ["bundle", "exec", "rake"], source: "default" });
  else notes.push("no test command found (no CI test step, spec/, Rails app or Rakefile)");

  // A Rails app eager-loads every constant: a removed class fails here, before any test runs.
  if (rails) checks.unshift({ name: "typecheck", argv: ["bin/rails", "zeitwerk:check"], source: "default" });
  else if (has("sorbet/config"))
    checks.unshift({ name: "typecheck", argv: ["bundle", "exec", "srb", "tc"], source: "default" });
  else if (has("Steepfile"))
    checks.unshift({ name: "typecheck", argv: ["bundle", "exec", "steep", "check"], source: "default" });

  const setup = ci.setup[0] ?? (rails && services.size ? "bin/rails db:prepare" : undefined);
  const ruby = rubyPin(tree, project);
  // No exact pin: the Ruby the repo's CI tests on, as a preference the lockfile can still overrule.
  const preferred = ruby ? null : rubyFor(tree, root);
  if (preferred?.note) notes.push(preferred.note);
  const env: Record<string, string> = {
    ...ci.env,
    ...(rails ? { RAILS_ENV: ci.env.RAILS_ENV ?? "test" } : {}),
    BUNDLE_FROZEN: project.lockfile ? "true" : "false",
    // Bundler 4 dropped `bundle` without a command printing help; keep its messages plain.
    NO_COLOR: "1",
  };
  if (services.size) notes.push(`services on localhost: ${[...services].join(", ")}`);
  if (setup) notes.push(`database setup: ${setup}`);
  if (ruby) notes.push(`Ruby ${ruby} (repo pin)`);
  return {
    manager: "bundler",
    image: "ruby",
    // Native extensions compile during the install; Rails suites are large.
    instance: rails ? "standard-3" : "standard-2",
    cwd: root === "." ? sandboxRoot : join(sandboxRoot, root),
    install: ["teire-ruby", "install"],
    installEnv: {
      ...env,
      ...(services.size ? { TEIRE_SERVICES: [...services].join(",") } : {}),
      ...(setup ? { TEIRE_DB_SETUP: setup } : {}),
      ...(ruby ? { TEIRE_RUBY_VERSION: ruby } : {}),
      ...(preferred ? { TEIRE_RUBY_PREFER: preferred.version } : {}),
    },
    env,
    checks,
    provenOffline: true,
    notes,
  };
}
