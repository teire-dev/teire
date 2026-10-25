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
RUN for b in cargo rustc rustdoc rustfmt cargo-clippy clippy-driver; do \
      p="$(ls -d /usr/local/rustup/toolchains/*/bin)/$b"; [ -x "$p" ] && ln -sf "$p" "/usr/local/bin/$b"; \
    done; rustc --version
# API-surface diff (Route B: compiles both published versions), pinned by checksum.
ARG CSC_SHA256=cacadafaa5cd27ae6d05a74a103266917ebab4c5e43c898360e177d4fbf06a65
RUN curl -fsSL -o /tmp/csc.tar.gz \
    https://github.com/obi1kenobi/cargo-semver-checks/releases/download/v0.51.0/cargo-semver-checks-x86_64-unknown-linux-gnu.tar.gz \
  && echo "${CSC_SHA256}  /tmp/csc.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/csc.tar.gz -C /usr/local/bin cargo-semver-checks \
  && rm /tmp/csc.tar.gz && cargo-semver-checks --version
COPY teire-job teire-job-status /usr/local/bin/
WORKDIR /work
CMD ["sleep", "infinity"]
