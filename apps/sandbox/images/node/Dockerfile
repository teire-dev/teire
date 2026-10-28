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
# Older Node majors a repo can ask for (.nvmrc, .node-version, volta, engines): /opt/node/<major>,
# each checked against nodejs.org's SHASUMS256.txt, each with its own corepack. The image's own is 24.
RUN set -eux; for major in 18 20 22; do \
      dist="https://nodejs.org/dist/latest-v${major}.x"; \
      sums="$(curl -fsSL "$dist/SHASUMS256.txt")"; \
      file="$(printf '%s\n' "$sums" | awk '/-linux-x64\.tar\.xz$/ {print $2}')"; \
      curl -fsSLo "/tmp/$file" "$dist/$file"; \
      (cd /tmp && printf '%s\n' "$sums" | grep " ${file}\$" | sha256sum -c -); \
      mkdir -p "/opt/node/$major"; tar -xJf "/tmp/$file" -C "/opt/node/$major" --strip-components=1; rm "/tmp/$file"; \
      "/opt/node/$major/bin/node" "/opt/node/$major/bin/corepack" enable --install-directory "/opt/node/$major/bin"; \
      "/opt/node/$major/bin/node" --version; \
    done
# bun, for repos locked with bun.lock / bun.lockb.
RUN npm install -g bun@1.4.4 && bun --version
# Background-job helpers (setsid + log files + exit-code file) driven by the Durable Object.
COPY teire-job teire-job-status /usr/local/bin/
# The check phase runs as this user, as CI runs a repository's tests (not as root); the install
# phase runs as root with HOME=/home/teire, so the caches it fills are the ones the checks read.
RUN useradd -m -u 10001 -s /bin/bash teire
WORKDIR /work
# The instance stops when the main process exits; commands run through exec().
CMD ["sleep", "infinity"]
