import { describe, expect, it } from "vitest";
import { dependabotPullRequests } from "../src/jobs/fix";

describe("Dependabot's open PRs for a package (S18.6)", () => {
  it("matches its Bump and Update titles for that package only", async () => {
    const pr = (number: number, title: string, login = "dependabot[bot]") => ({
      number,
      title,
      html_url: `https://github.com/o/r/pull/${number}`,
      user: { login },
    });
    const octokit = {
      rest: {
        pulls: {
          list: async () => ({
            data: [
              pr(1, "Bump zod from 3.22.0 to 3.23.8"),
              pr(2, "Bump zod-to-json-schema from 3.0.0 to 3.1.0"),
              pr(3, "Update zod requirement from ^3.0 to ^4.0"),
              pr(4, "Bump zod from 3.22.0 to 4.0.0", "someone"),
            ],
          }),
        },
      },
    };
    expect((await dependabotPullRequests(octokit, "o", "r", "zod")).map((p) => p.number)).toEqual([1, 3]);
  });
});
