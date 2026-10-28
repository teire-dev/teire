/** Every tunable of the sandbox service in one place (plan D60). */

/** The ephemeral CA Cloudflare writes when the container starts; HTTPS interception is signed by it. */
export const INTERCEPT_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/** Idle time after the last request, alarm or job before the instance stops. */
export const IDLE_MS = 15 * 60_000;
/** How often the alarm checks running jobs; each alarm keeps the instance alive. */
export const ALARM_MS = 60_000;
/** How long a repeated start for the same run waits for the first one (tarball fetch included). */
export const START_WAIT_MS = 5 * 60_000;
/** Hard ceiling for one job, whatever the caller asks for. */
export const MAX_JOB_SECONDS = 60 * 60;
/** Short buffered commands (`exec` route) stay small: output lives in Durable Object memory. */
export const MAX_EXEC_SECONDS = 120;
export const MAX_EXEC_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Largest log chunk returned per request. */
export const MAX_LOG_CHUNK_BYTES = 1024 * 1024;
/** Signed tokens may not live longer than this. */
export const MAX_TOKEN_TTL_SECONDS = 2 * 60 * 60;

export const JOBS_DIR = "/var/lib/teire/jobs";
export const WORK_DIR = "/work";

/**
 * Hosts the install phase may read from (GET/HEAD over HTTPS only). Traced live per ecosystem in
 * context/09-build-research/generic/sandbox.md §2.4. Everything else, and every request in the
 * check phase, is denied and logged.
 */
export const REGISTRY_HOSTS = new Set([
  // npm, pnpm, yarn (corepack downloads the package managers from these too)
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  // Python
  "pypi.org",
  "files.pythonhosted.org",
  // JVM
  "repo.maven.apache.org",
  "repo1.maven.org",
  "maven-central.storage-download.googleapis.com",
  "plugins.gradle.org",
  "plugins-artifacts.gradle.org",
  "services.gradle.org",
  "dl.google.com",
  "maven.google.com",
  // Go
  "proxy.golang.org",
  "sum.golang.org",
  // Rust
  "index.crates.io",
  "static.crates.io",
  "crates.io",
  "static.rust-lang.org",
  // JDKs a JVM repo needs beyond the image's 17/21/25 (Temurin; the binaries come from github.com)
  "api.adoptium.net",
  // Ruby
  "rubygems.org",
  "index.rubygems.org",
  // Toolchain and release downloads redirected from github.com
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

/** Environment for every command: exec() does not inherit the image's ENV (only PATH). */
/**
 * The unprivileged user the check phase runs as, as CI runs a repository's tests: suites that
 * check file permissions or warn when run as root (diskonaut's header says "running as root")
 * behave as they do on CI. Every image creates it; the install phase runs as root with the same
 * HOME, so every cache the install fills is the one the checks read.
 */
export const CHECK_USER = "teire";
export const CHECK_HOME = "/home/teire";

export const BASE_ENV: Record<string, string> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: CHECK_HOME,
  CI: "1",
  NODE_EXTRA_CA_CERTS: INTERCEPT_CA,
  SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
  CURL_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
  GIT_SSL_CAINFO: "/etc/ssl/certs/ca-certificates.crt",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
};

export const SANDBOX_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const JOB_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type Phase = "install" | "check";
export type InstanceType = "standard-1" | "standard-2" | "standard-3" | "standard-4";
