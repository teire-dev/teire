# Sandbox image for JS/TS verification (plan S02a). Customer code runs here, never on the worker.
FROM docker.io/cloudflare/sandbox:1.0.3 AS shim

FROM node:24-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq procps unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*
# Helper used by the Files and DirectoryBackup classes of @cloudflare/sandbox.
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# pnpm and yarn come from corepack, pinned by each repo's packageManager field.
RUN corepack enable
# Background-job helpers (setsid + log files + exit-code file) driven by the Durable Object.
COPY teire-job teire-job-status /usr/local/bin/
WORKDIR /work
# The instance stops when the main process exits; commands run through exec().
CMD ["sleep", "infinity"]
