import { describe, expect, it } from "vitest";
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
