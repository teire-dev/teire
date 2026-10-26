import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchRepoTarball } from "@teire/engine/inventory";

/**
 * What a scan reads: a folder on this machine, or a public GitHub repository given as `owner/name`
 * or its URL, downloaded as one tarball into a temporary folder (no git, no clone) and removed after.
 * A folder that exists always wins, so `teire scan apps/web` never reaches GitHub.
 */
export interface Target {
  dir: string;
  /** How the report names what it read: the folder, or github.com/owner/name@sha. */
  label: string;
  github?: { owner: string; name: string; sha: string };
  cleanup: () => Promise<void>;
}

const GITHUB_URL =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^?#]+?))?\/?(?:[?#].*)?$/;
const OWNER_NAME = /^([A-Za-z0-9][\w-]*)\/([\w.-]+?)(?:\.git)?$/;

export function githubRef(arg: string) {
  const url = GITHUB_URL.exec(arg.trim());
  if (url) return { owner: url[1] as string, name: url[2] as string, ref: url[3] ?? "HEAD" };
  const short = OWNER_NAME.exec(arg.trim());
  return short ? { owner: short[1] as string, name: short[2] as string, ref: "HEAD" } : null;
}

export async function resolveTarget(arg: string | undefined, token?: string): Promise<Target> {
  const local = resolve(arg ?? ".");
  if (existsSync(local)) {
    if (!statSync(local).isDirectory())
      throw new Error(`${arg} is a file. Give a folder to scan, or a GitHub repository as owner/name`);
    return { dir: local, label: local, cleanup: async () => undefined };
  }
  const gh = arg ? githubRef(arg) : null;
  if (!gh)
    throw new Error(
      `${arg}: no such folder. To scan a public GitHub repository without cloning it, give owner/name or its URL`,
    );
  const checkout = await fetchRepoTarball(gh.owner, gh.name, gh.ref, token ? { token } : {}).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/ 404 /.test(message))
        throw new Error(
          `github.com/${gh.owner}/${gh.name} was not found${gh.ref === "HEAD" ? "" : ` at ${gh.ref}`}, or it is private (set GITHUB_TOKEN to read a private repository you can see)`,
        );
      if (/ 40[13] /.test(message))
        throw new Error(
          `GitHub refused the download (${message}). Without GITHUB_TOKEN, GitHub allows 60 requests an hour; set GITHUB_TOKEN and try again`,
        );
      throw new Error(`could not download github.com/${gh.owner}/${gh.name}: ${message}`);
    },
  );
  const sha = checkout.sha ?? gh.ref;
  return {
    dir: checkout.dir,
    label: `github.com/${gh.owner}/${gh.name}@${sha.slice(0, 7)}`,
    github: { owner: gh.owner, name: gh.name, sha },
    cleanup: () => rm(checkout.dir, { recursive: true, force: true }),
  };
}
