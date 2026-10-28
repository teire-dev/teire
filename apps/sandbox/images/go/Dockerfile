# Sandbox image for Go verification (plan S05). Customer code builds and runs here, never on the worker.
FROM docker.io/cloudflare/sandbox:1.0.3 AS shim

# Go 1.27.2 (≥ two weeks old on 2026-10-25; research go.md verified 1.27.x).
FROM docker.io/library/golang:1.27.2-trixie
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq procps unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# exec() does not inherit the image's ENV, only a fixed PATH: put the toolchain on it.
RUN ln -s /usr/local/go/bin/go /usr/local/bin/go && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt
# Advisory reachability (research go.md Job 9), pinned.
RUN GOBIN=/usr/local/bin GOTOOLCHAIN=local go install golang.org/x/vuln/cmd/govulncheck@v1.8.0 \
  && rm -rf /root/go/pkg/mod /root/.cache/go-build
# Go 1.20+ ships no precompiled standard library: build it once so the first check is not paying for it.
RUN GOTOOLCHAIN=local go build std && GOTOOLCHAIN=local go vet std >/dev/null 2>&1 || true
COPY teire-job teire-job-status /usr/local/bin/
# The check phase runs as this user, as CI runs a repository's tests (not as root); the install
# phase runs as root with HOME=/home/teire, so the caches it fills are the ones the checks read.
RUN useradd -m -u 10001 -s /bin/bash teire
WORKDIR /work
CMD ["sleep", "infinity"]
