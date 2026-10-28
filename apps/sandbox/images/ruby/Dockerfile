# Sandbox image for Ruby verification (plan S07). Gemfiles, gemspecs, database.yml (ERB) and gem
# native extensions are Ruby code or compilers: they run here, never on the worker.
FROM docker.io/cloudflare/sandbox:1.0.3 AS shim

# The full image (not slim): native extensions need compilers and -dev libraries (research ruby.md
# Job 8: bigdecimal failed on slim). Ruby 4.0.9 with Bundler 4.0.20 (`bundle lock --cooldown`).
FROM docker.io/library/ruby:4.0.9-trixie
# Databases and caches Rails test suites expect on localhost (research: postgres in most deployed
# apps, then mysql; redis for Sidekiq/Action Cable). They start only when the plan asks for them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq procps unzip xz-utils \
     postgresql postgresql-contrib redis-server mariadb-server libvips42 \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s /usr/lib/postgresql/*/bin/initdb /usr/lib/postgresql/*/bin/pg_ctl /usr/local/bin/
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# rv 0.7.1 (spinel-coop, MIT/Apache-2.0): precompiled Rubies for repos pinning another version.
ARG RV_SHA256=f5cc7e94d349547bc80b0cdcac60dcad0503837d5ce0f7da181d892da08df1b8
RUN curl -fsSL -o /tmp/rv.tar.xz \
    https://github.com/spinel-coop/rv/releases/download/v0.7.1/rv-x86_64-unknown-linux-gnu.tar.xz \
  && echo "${RV_SHA256}  /tmp/rv.tar.xz" | sha256sum -c - \
  && tar -xJf /tmp/rv.tar.xz -C /tmp && find /tmp -name rv -type f -perm -u+x -exec mv {} /usr/local/bin/rv \; \
  && rm -rf /tmp/rv* && rv --version
# exec() does not inherit the image's ENV (GEM_HOME, BUNDLE_APP_CONFIG): every command gets Ruby's
# own defaults, so gems install to the default GEM_HOME and binstubs land in /usr/local/bin.
RUN rm -rf /usr/local/bundle && ruby -v && bundle -v
COPY teire-job teire-job-status teire-ruby /usr/local/bin/
# The check phase runs as this user, as CI runs a repository's tests (not as root); the install
# phase runs as root with HOME=/home/teire, so the caches it fills are the ones the checks read.
RUN useradd -m -u 10001 -s /bin/bash teire
WORKDIR /work
CMD ["sleep", "infinity"]
