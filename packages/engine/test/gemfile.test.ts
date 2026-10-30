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
