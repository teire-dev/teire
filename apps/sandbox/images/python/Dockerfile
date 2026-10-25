# Sandbox image for Python verification (plan S03). Customer code runs here, never on the worker.
FROM docker.io/cloudflare/sandbox:1.0.3 AS shim

# uv 0.13.5 with CPython 3.12 (the image the research verified installs and offline checks with).
FROM ghcr.io/astral-sh/uv:0.13.5-python3.12-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq procps unzip xz-utils build-essential \
  && rm -rf /var/lib/apt/lists/*
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# Each repo's own lock tool, at the versions the research verified: Poetry, Pipenv, pip-tools.
ENV UV_TOOL_BIN_DIR=/usr/local/bin UV_TOOL_DIR=/opt/uv-tools UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
RUN uv tool install poetry==2.5.1 \
  && uv tool install pipenv==2026.10.2 \
  && uv tool install pip-tools==7.6.2
COPY teire-job teire-job-status /usr/local/bin/
WORKDIR /work
CMD ["sleep", "infinity"]
