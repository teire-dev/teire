import { App, type Octokit } from "octokit";

/**
 * Teire's GitHub App on the worker (plan D75: the private key lives on the worker only).
 * octokit's App signs the JWT and caches installation tokens (valid one hour) per installation.
 */
export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  slug: string;
}

export function githubAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const slug = env.GITHUB_APP_SLUG;
  if (!appId || !privateKey || !slug)
    throw new Error("GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_APP_SLUG must be set");
  return { appId, privateKey, slug };
}

export interface Installation {
  octokit: Octokit;
  /** Installation token for requests octokit does not make itself (repo tarballs into the sandbox). */
  token: () => Promise<string>;
}

export function createGitHubApp(config: GitHubAppConfig) {
  const app = new App({ appId: config.appId, privateKey: config.privateKey });
  return {
    app,
    slug: config.slug,
    /** Login commits and comments carry: `teire-bot[bot]`. */
    botLogin: `${config.slug}[bot]`,
    async installation(id: number): Promise<Installation> {
      const octokit = await app.getInstallationOctokit(id);
      return {
        octokit,
        token: async () => ((await octokit.auth({ type: "installation" })) as { token: string }).token,
      };
    },
  };
}

export type GitHubApp = ReturnType<typeof createGitHubApp>;
