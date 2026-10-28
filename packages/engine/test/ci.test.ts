import { describe, expect, it } from "vitest";
import { memoryTree } from "../src/inventory/tree";
import { ciJobsFor } from "../src/verify/ci";

const tree = memoryTree({
  ".github/workflows/rails.yml": [
    "on: { push: { paths: ['rails-db/**'] } }",
    "jobs:",
    "  test:",
    "    defaults: { run: { working-directory: rails-db } }",
    "    services: { postgres: { image: postgres:17 } }",
    "    steps: [{ run: bin/rails test }]",
  ].join("\n"),
  ".github/workflows/ruby.yml": [
    "jobs:",
    "  test:",
    "    defaults: { run: { working-directory: ./ruby-major } }",
    "    steps: [{ run: bundle exec rake test }]",
  ].join("\n"),
  ".github/workflows/lint.yml": "jobs:\n  lint:\n    steps: [{ run: npm run lint }]\n",
});

describe("CI jobs per project in a monorepo", () => {
  it("gives each folder its own jobs, so one project's services never leak into another", () => {
    expect(ciJobsFor(tree, "rails-db").map((j) => j.file)).toEqual([".github/workflows/rails.yml"]);
    expect(ciJobsFor(tree, "ruby-major").map((j) => j.file)).toEqual([".github/workflows/ruby.yml"]);
    expect(ciJobsFor(tree, ".").map((j) => j.file)).toEqual([".github/workflows/lint.yml"]);
  });
});
