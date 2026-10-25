# Teire worker. Build context: repository root.
# Recipe: coolify skill (node-production) — compile in a build stage, ship a small runtime stage,
# node as PID 1, non-root, migrations applied at start from an absolute path.

FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/engine/package.json packages/engine/
RUN pnpm install --frozen-lockfile --filter @teire/worker...
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker
RUN pnpm --filter @teire/worker build
RUN pnpm --filter @teire/worker deploy --prod --legacy --config.node-linker=hoisted /out \
  && cp -r apps/worker/dist /out/dist \
  && cp -r packages/db/drizzle /out/drizzle

# Teire's Go helper (plan S05): apidiff and type-resolved locate, built with the pinned modules.
FROM docker.io/library/golang:1.27.2-trixie AS gohelper
WORKDIR /src
COPY packages/helpers/go/ ./
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -o /out/teire-go . \
  && CGO_ENABLED=0 GOTOOLCHAIN=local GOBIN=/out go install golang.org/x/vuln/cmd/govulncheck@v1.8.0

FROM node:24-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep \
  && rm -rf /var/lib/apt/lists/*
# Universal lockfile reader, extraction only (plan D56). Pinned and checked against the release's
# published SHA256SUMS.
ARG OSV_SCANNER_VERSION=v2.6.0
ARG OSV_SCANNER_SHA256=ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108
RUN curl -fsSL -o /usr/local/bin/osv-scanner \
    "https://github.com/google/osv-scanner/releases/download/${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64" \
  && echo "${OSV_SCANNER_SHA256}  /usr/local/bin/osv-scanner" | sha256sum -c - \
  && chmod 0755 /usr/local/bin/osv-scanner
# OpenAPI diffs (plan S04, D64): oasdiff pinned, since its output differs between versions; checked
# against the release's checksums.txt. It parses specs only; external $refs stay off.
ARG OASDIFF_VERSION=1.34.1
ARG OASDIFF_SHA256=75775f65b0adebd26a8e013af51a799342dfdc6262d89efa9e3b7bdf89657d90
RUN curl -fsSL -o /tmp/oasdiff.tar.gz \
    "https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/oasdiff_${OASDIFF_VERSION}_linux_amd64.tar.gz" \
  && echo "${OASDIFF_SHA256}  /tmp/oasdiff.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/oasdiff.tar.gz -C /usr/local/bin oasdiff \
  && chmod 0755 /usr/local/bin/oasdiff \
  && rm /tmp/oasdiff.tar.gz \
  && oasdiff --version
# Rust API-surface diff, Route A (plan S06): cargo-semver-checks on docs.rs rustdoc JSON. It reads two
# JSON files and needs no Rust toolchain (checked with an empty PATH); pinned by checksum.
ARG CSC_SHA256=cacadafaa5cd27ae6d05a74a103266917ebab4c5e43c898360e177d4fbf06a65
RUN curl -fsSL -o /tmp/csc.tar.gz \
    https://github.com/obi1kenobi/cargo-semver-checks/releases/download/v0.51.0/cargo-semver-checks-x86_64-unknown-linux-gnu.tar.gz \
  && echo "${CSC_SHA256}  /tmp/csc.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/csc.tar.gz -C /usr/local/bin cargo-semver-checks \
  && rm /tmp/csc.tar.gz && cargo-semver-checks --version
# Python for Teire's helper (plan S03): uv-managed CPython 3.12 and a venv with the pinned readers.
# The helper reads manifests, wheels and source; it never imports or runs a repo's code.
COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_LINK_MODE=copy
RUN uv python install 3.12 \
  && uv venv /opt/teire-py --python 3.12 \
  && uv pip install --python /opt/teire-py/bin/python packaging==26.3 griffe==2.4.1 jedi==0.20.1
# Go toolchain for the worker's Go readers (go mod edit, go list -m, apidiff, locate), always run in
# the safe mode of D88: GOTOOLCHAIN=local, CGO_ENABLED=0, GOENV/GOWORK off, proxy only, scratch HOME.
COPY --from=gohelper /usr/local/go /usr/local/go
WORKDIR /app
COPY packages/helpers/python/teire_py.py /app/helpers/teire_py.py
COPY --from=gohelper /out/teire-go /out/govulncheck /app/helpers/
RUN mkdir -p /var/cache/teire-go && chown node:node /var/cache/teire-go
ENV NODE_ENV=production \
    PORT=8080 \
    MIGRATIONS_DIR=/app/drizzle \
    TEIRE_PYTHON=/opt/teire-py/bin/python \
    TEIRE_PY_HELPER=/app/helpers/teire_py.py \
    TEIRE_AST_GREP=/app/node_modules/@ast-grep/cli-linux-x64-gnu/ast-grep \
    TEIRE_GO=/usr/local/go/bin/go \
    TEIRE_GO_HELPER=/app/helpers/teire-go \
    TEIRE_GOVULNCHECK=/app/helpers/govulncheck \
    TEIRE_CARGO_SEMVER_CHECKS=/usr/local/bin/cargo-semver-checks \
    TEIRE_GO_CACHE=/var/cache/teire-go \
    UV_PYTHON_DOWNLOADS=never
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/drizzle ./drizzle
# ast-grep 0.50 (literal locator) arrives as the engine's optional platform package; fail here if not.
RUN "$TEIRE_AST_GREP" --version
USER node
EXPOSE 8080
# Heap sized from measured peaks: a TypeScript surface diff of a large SDK pair reached ~730 MB RSS.
CMD ["node", "--enable-source-maps", "--max-old-space-size=2560", "dist/bundle/main.mjs"]
