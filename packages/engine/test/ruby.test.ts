import { describe, expect, it } from "vitest";
import { type RubysecAdvisory, rubysecAffects, rubysecFixedIn } from "../src/advisories/rubysec";
import { editGemRequirement, gemRequirementFor } from "../src/fix/upgrade-ruby";
import { gemfileGroups, parseGemfileLock, readRubyInventory } from "../src/inventory/ruby";
import { memoryTree } from "../src/inventory/tree";
import { countsFromOutput } from "../src/verify/reports";
import { detectRubyChecks } from "../src/verify/ruby-commands";

const LOCK = `GEM
  remote: https://rubygems.org/
  specs:
    base64 (0.3.0)
    faraday (1.10.6)
      faraday-net_http (~> 1.0)
      ruby2_keywords (>= 0.0.4)
    faraday-net_http (1.0.2)
    minitest (5.27.0)
    nokogiri (1.19.4-x86_64-linux-gnu)
      racc (~> 1.4)
    racc (1.8.1)
    ruby2_keywords (0.0.5)

PLATFORMS
  ruby
  x86_64-linux

DEPENDENCIES
  base64 (~> 0.3)
  faraday (~> 1.10)
  minitest (~> 5.25)
  nokogiri

RUBY VERSION
   ruby 4.0.9p0

BUNDLED WITH
  4.0.20
`;

const GEMFILE = `source "https://rubygems.org"

# HTTP client — keep on 1.x
gem 'faraday', '~> 1.10', require: false # pinned
gem "base64", "~> 0.3"
gem "nokogiri"

group :development, :test do
  gem "minitest", "~> 5.25"
end
`;

describe("Bundler inventory (Teire's own Gemfile.lock parser)", () => {
  it("reads specs, platform variants, direct requirements and the Ruby version", () => {
    const lock = parseGemfileLock(LOCK);
    expect(lock.specs.find((s) => s.name === "nokogiri")).toMatchObject({
      version: "1.19.4",
      platform: "x86_64-linux-gnu",
    });
    expect(lock.dependencies.find((d) => d.name === "faraday")?.requirement).toBe("~> 1.10");
    expect(lock.platforms).toEqual(["ruby", "x86_64-linux"]);
    expect(lock.rubyVersion).toBe("4.0.9p0");
    expect(lock.bundledWith).toBe("4.0.20");
  });

  it("reads Gemfile groups as text and scopes direct gems", () => {
    expect(gemfileGroups(GEMFILE).get("minitest")).toEqual(["development", "test"]);
    const [project] = readRubyInventory(memoryTree({ Gemfile: GEMFILE, "Gemfile.lock": LOCK }));
    const faraday = project?.instances.find((i) => i.name === "faraday");
    expect(faraday).toMatchObject({
      version: "1.10.6",
      direct: true,
      scope: "prod",
      declaredRange: "~> 1.10",
    });
    expect(project?.instances.find((i) => i.name === "minitest")?.scope).toBe("dev");
    expect(project?.instances.find((i) => i.name === "racc")?.direct).toBe(false);
    expect(project?.rubyVersion).toBe("4.0.9");
  });
});

describe("Gem requirement edits (Prism byte splice)", () => {
  it("moves only requirements that exclude the target, in their own style", () => {
    expect(gemRequirementFor(["~> 1.10"], "2.14.4")).toEqual(["~> 2.14"]);
    expect(gemRequirementFor(["~> 1.10.3"], "2.14.4")).toEqual(["~> 2.14.4"]);
    expect(gemRequirementFor([">= 1.0", "< 2"], "2.14.4")).toEqual([">= 1.0", "< 3"]);
    expect(gemRequirementFor(["= 1.10.6"], "2.14.4")).toEqual(["= 2.14.4"]);
    expect(gemRequirementFor([">= 1.0"], "2.14.4")).toBeNull();
  });

  it("keeps quotes, comments, options and everything else in the Gemfile", async () => {
    const edit = await editGemRequirement(GEMFILE, "faraday", "2.14.4");
    expect(edit?.text).toBe(GEMFILE.replace("'~> 1.10'", "'~> 2.14'"));
    expect(edit).toMatchObject({ from: "~> 1.10", to: "~> 2.14" });
    // No requirement written: nothing to move.
    expect(await editGemRequirement(GEMFILE, "nokogiri", "2.0.0")).toBeNull();
  });

  it("edits a gemspec's add_dependency", async () => {
    const spec = `Gem::Specification.new do |spec|\n  spec.add_dependency "faraday", ">= 1.0", "< 2"\nend\n`;
    expect((await editGemRequirement(spec, "faraday", "2.14.4"))?.text).toContain(
      `"faraday", ">= 1.0", "< 3"`,
    );
  });
});

describe("Ruby test counts", () => {
  it("reads RSpec's summary, errors outside examples included", () => {
    expect(countsFromOutput("Finished in 0.45 seconds\n657 examples, 2 failures, 3 pending\n")).toEqual({
      collected: 657,
      passed: 652,
      failed: 2,
      skipped: 3,
      errors: 0,
    });
    expect(countsFromOutput("0 examples, 0 failures, 1 error occurred outside of examples\n")?.errors).toBe(
      1,
    );
  });

  it("sums Minitest's summary lines", () => {
    expect(countsFromOutput("6 runs, 8 assertions, 0 failures, 0 errors, 0 skips\n")).toEqual({
      collected: 6,
      passed: 6,
      failed: 0,
      skipped: 0,
      errors: 0,
    });
    expect(
      countsFromOutput(
        "3 runs, 3 assertions, 1 failures, 0 errors, 0 skips\n2 runs, 2 assertions, 0 failures, 1 errors, 1 skips\n",
      ),
    ).toEqual({ collected: 5, passed: 2, failed: 1, skipped: 1, errors: 1 });
  });
});

describe("Ruby check recipe", () => {
  const CI = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
      redis:
        image: redis:7
    env:
      RAILS_ENV: test
      DATABASE_URL: postgres://rails:password@localhost:5432/app_test
      MASTER_KEY: \${{ secrets.MASTER_KEY }}
    steps:
      - uses: actions/checkout@v4
      - run: bin/rails db:prepare
      - run: bin/rails test
      - run: bundle exec rubocop
`;

  it("takes the test step, services, plain env and database setup from CI, never secrets", () => {
    const tree = memoryTree({
      Gemfile: GEMFILE,
      "Gemfile.lock": `${LOCK.replace("    minitest (5.27.0)\n", "    minitest (5.27.0)\n    sidekiq (7.3.0)\n")}`,
      "config/application.rb": "module App; end\n",
      "config/database.yml": "test:\n  adapter: postgresql\n",
      ".github/workflows/ci.yml": CI,
    });
    const [project] = readRubyInventory(tree);
    const plan = detectRubyChecks(tree, project as NonNullable<typeof project>);
    expect(plan.checks.map((c) => c.argv.join(" "))).toEqual(["bin/rails zeitwerk:check", "bin/rails test"]);
    expect(plan.installEnv).toMatchObject({
      TEIRE_SERVICES: "postgres,redis",
      TEIRE_DB_SETUP: "bin/rails db:prepare",
      DATABASE_URL: "postgres://rails:password@localhost:5432/app_test",
      BUNDLE_FROZEN: "true",
      TEIRE_RUBY_VERSION: "4.0.9",
    });
    expect(plan.env).not.toHaveProperty("MASTER_KEY");
    expect(plan).toMatchObject({ image: "ruby", instance: "standard-3", install: ["teire-ruby", "install"] });
  });

  it("falls back to the Rakefile for a library without CI", () => {
    const tree = memoryTree({ Gemfile: GEMFILE, "Gemfile.lock": LOCK, Rakefile: "task default: :test\n" });
    const [project] = readRubyInventory(tree);
    const plan = detectRubyChecks(tree, project as NonNullable<typeof project>);
    expect(plan.checks.map((c) => c.argv.join(" "))).toEqual(["bundle exec rake"]);
    expect(plan.installEnv).not.toHaveProperty("TEIRE_SERVICES");
  });
});

describe("ruby-advisory-db matching", () => {
  const advisory: RubysecAdvisory = {
    gem: "faraday",
    id: "GHSA-98m9-hrrm-r99r",
    aliases: ["CVE-2026-0001"],
    url: "https://example.com",
    title: "t",
    date: null,
    patched: ["~> 1.10.6", ">= 2.14.3"],
    unaffected: ["< 1.0.0"],
  };

  it("affects versions no patched or unaffected requirement admits", () => {
    expect(rubysecAffects(advisory, "1.10.3")).toBe(true);
    expect(rubysecAffects(advisory, "1.10.6")).toBe(false);
    expect(rubysecAffects(advisory, "2.15.0")).toBe(false);
    expect(rubysecAffects(advisory, "0.17.0")).toBe(false);
    expect(rubysecFixedIn(advisory)).toEqual(["1.10.6", "2.14.3"]);
  });
});
