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
# Python for Teire's helper (plan S03): uv-managed CPython 3.12 and a venv with the pinned readers.
# The helper reads manifests, wheels and source; it never imports or runs a repo's code.
COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_LINK_MODE=copy
RUN uv python install 3.12 \
  && uv venv /opt/teire-py --python 3.12 \
  && uv pip install --python /opt/teire-py/bin/python packaging==26.3 griffe==2.4.1 jedi==0.20.1
WORKDIR /app
COPY packages/helpers/python/teire_py.py /app/helpers/teire_py.py
ENV NODE_ENV=production \
    PORT=8080 \
    MIGRATIONS_DIR=/app/drizzle \
    TEIRE_PYTHON=/opt/teire-py/bin/python \
    TEIRE_PY_HELPER=/app/helpers/teire_py.py \
    TEIRE_AST_GREP=/app/node_modules/@ast-grep/cli-linux-x64-gnu/ast-grep \
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
