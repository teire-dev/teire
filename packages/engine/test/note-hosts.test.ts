import { describe, expect, it, vi } from "vitest";
import { sourceRepoOf } from "../src/notes/hosts";

describe("a package's own repository, wherever its metadata says it is (S16.5)", () => {
  it("reads GitHub, GitLab with nested groups, and Bitbucket URLs", () => {
    expect(sourceRepoOf("git+https://github.com/openai/openai-node.git")).toEqual({
      host: "github",
      owner: "openai",
      repo: "openai-node",
    });
    expect(sourceRepoOf("https://gitlab.com/sscherfke/typed-settings")).toEqual({
      host: "gitlab",
      owner: "sscherfke",
      repo: "typed-settings",
    });
    expect(sourceRepoOf("https://gitlab.com/group/sub/project/-/tree/main")).toEqual({
      host: "gitlab",
      owner: "group/sub",
      repo: "project",
    });
    expect(sourceRepoOf("git@bitbucket.org:atlassian/python-bitbucket.git")).toEqual({
      host: "bitbucket",
      owner: "atlassian",
      repo: "python-bitbucket",
    });
  });

  it("reads npm's shorthands, the bare one meaning GitHub", () => {
    expect(sourceRepoOf("expressjs/express")).toEqual({
      host: "github",
      owner: "expressjs",
      repo: "express",
    });
    expect(sourceRepoOf("gitlab:group/project")).toEqual({ host: "gitlab", owner: "group", repo: "project" });
    expect(sourceRepoOf("bitbucket:ws/repo")).toEqual({ host: "bitbucket", owner: "ws", repo: "repo" });
  });

  it("reads nothing from other hosts or plain text", () => {
    expect(sourceRepoOf("https://git.example.org/team/lib")).toBeNull();
    expect(sourceRepoOf("https://example.org")).toBeNull();
    expect(sourceRepoOf("")).toBeNull();
  });
});

describe("a date-stamped tag, from the version's publish date (S16.5)", () => {
  it("finds the day's tag in any spelling, the day before after it", async () => {
    const { tagsDated } = await import("../src/notes/hosts");
    const listing = [
      "v1.0.0",
      "release-20240314",
      "2024.03.15",
      "nightly-2024-03-151",
      "build-12024-03-15",
      "v2024_03_15",
    ];
    const fetch = await import("../src/net/fetch");
    const spy = vi.spyOn(fetch, "guardedFetch").mockResolvedValue({
      status: 200,
      json: () => listing.map((t) => ({ ref: `refs/tags/${t}` })),
    } as never);
    expect(await tagsDated({ host: "github", owner: "o", repo: "r" }, "2024-03-15T09:00:00Z")).toEqual([
      "2024.03.15",
      "v2024_03_15",
      "release-20240314",
    ]);
    spy.mockRestore();
  });
});
