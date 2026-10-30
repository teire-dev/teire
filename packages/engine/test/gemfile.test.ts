import { describe, expect, it } from "vitest";
import { gemfileGems, readRubyInventory } from "../src/inventory/ruby";
import type { RepoTree } from "../src/inventory/tree";

const GEMFILE = `source "https://rubygems.org"

gem "rails", "~> 7.0", ">= 7.0.4"
gem "pg" # any version
gem "devise", github: "heartcombo/devise"
gem "local_tool", path: "../local_tool"

group :development, :test do
  if RUBY_VERSION >= "3.2"
    gem "debug", ">= 1.0.0"
  end
  platforms :mri do
    gem "byebug"
  end
  gem "rspec-rails", "~> 6.1"
end

group(:test) do
  gem "capybara", "~> 3.39", require: false
end

source "https://gems.acme.dev" do
  gem "acme-client", "~> 2.0"
end

gem "sidekiq", "< 8"
`;

describe("a Gemfile read as text (D-18, D-25)", () => {
  const gems = gemfileGems(GEMFILE);

  it("keeps each gem's own requirements and where it comes from", () => {
    expect(gems.get("rails")).toEqual({ groups: [], requirement: "~> 7.0, >= 7.0.4" });
    expect(gems.get("pg")).toEqual({ groups: [] });
    expect(gems.get("devise")?.source).toBe("git");
    expect(gems.get("local_tool")?.source).toBe("path");
    expect(gems.get("acme-client")).toMatchObject({ requirement: "~> 2.0", source: "private-index" });
    expect(gems.get("capybara")).toEqual({ groups: ["test"], requirement: "~> 3.39" });
  });

  it("ends an if or platforms block at its own end, not the group's", () => {
    expect(gems.get("debug")?.groups).toEqual(["development", "test"]);
    expect(gems.get("byebug")?.groups).toEqual(["development", "test"]);
    expect(gems.get("rspec-rails")?.groups).toEqual(["development", "test"]);
    expect(gems.get("sidekiq")?.groups).toEqual([]);
  });

  it("gives a lockless Gemfile's gems their declared ranges", () => {
    const tree: RepoTree = { files: () => ["Gemfile"], read: (p) => (p === "Gemfile" ? GEMFILE : null) };
    const [project] = readRubyInventory(tree);
    const of = (name: string) => project?.instances.find((i) => i.name === name);
    expect(of("rails")).toMatchObject({
      version: null,
      declaredRange: "~> 7.0, >= 7.0.4",
      source: "registry",
    });
    expect(of("rspec-rails")).toMatchObject({ declaredRange: "~> 6.1", scope: "dev" });
    expect(of("capybara")?.scope).toBe("test");
    expect(of("devise")?.source).toBe("git");
    expect(of("acme-client")?.source).toBe("private-index");
  });
});

describe("the Ruby a project runs on (D-39)", () => {
  it("reads the Gemfile's ruby line, a file it names, and a gemspec's floor", async () => {
    const { gemfileRuby, gemspecRubyFloor } = await import("../src/inventory/ruby");
    const none = () => null;
    expect(gemfileRuby('source "https://rubygems.org"\nruby "3.2.2"\ngem "rails"\n', none)).toBe("3.2.2");
    expect(gemfileRuby("ruby '~> 3.1.0'\n", none)).toBe("3.1.0");
    expect(
      gemfileRuby('ruby file: ".ruby-version"\n', (p) => (p === ".ruby-version" ? "ruby-3.3.4\n" : null)),
    ).toBe("3.3.4");
    expect(gemfileRuby('gem "ruby-progressbar"\n', none)).toBeNull();
    expect(gemspecRubyFloor('  spec.required_ruby_version = ">= 3.0"\n')).toBe("3.0");
    expect(gemspecRubyFloor('s.required_ruby_version = Gem::Requirement.new(">= 2.7.0")\n')).toBe("2.7.0");
    expect(gemspecRubyFloor('spec.required_ruby_version = [">= 2.6", "< 4"]\n')).toBe("2.6");
  });
});
