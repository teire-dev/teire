# Sandbox image for Rust verification (plan S06). Crates build, run build scripts and proc-macros
# here, never on the worker.
FROM docker.io/cloudflare/sandbox:1.0.3 AS shim

# Stable Rust 1.99.1 (research rust.md verified builds, tests and cargo-semver-checks 0.51.0 on it).
FROM docker.io/library/rust:1.99.1-slim-trixie
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq procps unzip xz-utils pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# exec() does not inherit the image's ENV, only a fixed PATH: link the toolchain's own binaries (not
# rustup's proxies), so a repo's rust-toolchain.toml can never make rustup install another toolchain.
# rust-analyzer and the standard library's source for type-resolved locating at scan time (S19,
# `rust-analyzer scip`): without rust-src most std references don't resolve.
RUN rustup component add rust-src rust-analyzer
RUN for b in cargo rustc rustdoc rustfmt cargo-clippy clippy-driver rust-analyzer; do \
      p="$(ls -d /usr/local/rustup/toolchains/*/bin)/$b"; [ -x "$p" ] && ln -sf "$p" "/usr/local/bin/$b"; \
    done; rustc --version && rust-analyzer --version
# rustup itself, so a repo's rust-toolchain pin is installed explicitly by the install step (D-47);
# the proxies stay unlinked, so nothing else ever switches toolchains on its own.
RUN ln -sf /usr/local/cargo/bin/rustup /usr/local/bin/rustup && rustup --version
# API-surface diff (Route B: compiles both published versions), pinned by checksum.
ARG CSC_SHA256=cacadafaa5cd27ae6d05a74a103266917ebab4c5e43c898360e177d4fbf06a65
RUN curl -fsSL -o /tmp/csc.tar.gz \
    https://github.com/obi1kenobi/cargo-semver-checks/releases/download/v0.51.0/cargo-semver-checks-x86_64-unknown-linux-gnu.tar.gz \
  && echo "${CSC_SHA256}  /tmp/csc.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/csc.tar.gz -C /usr/local/bin cargo-semver-checks \
  && rm /tmp/csc.tar.gz && cargo-semver-checks --version
COPY teire-job teire-job-status /usr/local/bin/
# The check phase runs as this user, as CI runs a repository's tests (not as root); the install
# phase runs as root with HOME=/home/teire, so the caches it fills are the ones the checks read.
RUN useradd -m -u 10001 -s /bin/bash teire
WORKDIR /work
CMD ["sleep", "infinity"]
