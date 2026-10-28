#!/bin/sh
# Installs the resolver daemon on the Coolify host (plan D93). Run as root from this folder.
# The stop rule: Coolify must reach DNS, the internet and Postgres before and after; if not,
# `./install.sh remove` takes everything out again.
set -eu
cd "$(dirname "$0")"
check() { /usr/local/sbin/teire-coolify-check; }

case "${1:-install}" in
  install)
    sh ./coolify-check.sh
    install -d /etc/teire-resolver /usr/local/lib/teire-resolver
    install -m 0755 coolify-check.sh /usr/local/sbin/teire-coolify-check
    install -m 0644 daemon.json resolv.conf /etc/teire-resolver/
    install -m 0755 firewall.sh runsc-wrapper.sh teire-resolver.py /usr/local/lib/teire-resolver/
    install -m 0644 images.json /etc/teire-resolver/
    # The dependabot CLI at the version images.json pins, checked against its release tarball's
    # sha256 (the CLI and the images move together: its decoder rejects unknown job fields).
    cli=$(python3 -c 'import json; print(json.load(open("images.json"))["cli"])')
    sum=$(python3 -c 'import json; print(json.load(open("images.json"))["cliSha256"])')
    if [ "$(dependabot --version 2>/dev/null | awk '{print $3}')" != "$cli" ]; then
      tmp=$(mktemp -d)
      curl -fsSL -o "$tmp/cli.tgz" "https://github.com/dependabot/cli/releases/download/$cli/dependabot-$cli-linux-amd64.tar.gz"
      echo "$sum  $tmp/cli.tgz" | sha256sum -c -
      tar -xzf "$tmp/cli.tgz" -C "$tmp" dependabot
      install -m 0755 "$tmp/dependabot" /usr/local/bin/dependabot
      rm -rf "$tmp"
    fi
    install -m 0644 teire-resolver.slice docker-resolver.service teire-resolver.service /etc/systemd/system/
    # The shared secret the worker sends; generated here once, never printed.
    if [ ! -f /etc/teire-resolver/env ]; then
      umask 077
      printf 'TEIRE_RESOLVER_SECRET=%s\nTEIRE_RESOLVER_BIND=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
        "$(docker network inspect coolify --format '{{(index .IPAM.Config 0).Gateway}}'):8787" > /etc/teire-resolver/env
    fi
    systemctl daemon-reload
    systemctl enable --now docker-resolver.service teire-resolver.service
    # The stop rule, enforced: if Coolify lost anything, the resolver comes out again at once.
    if ! check; then
      echo "teire-resolver: Coolify check failed after install; removing the resolver daemon" >&2
      "$0" remove
      exit 1
    fi
    ;;
  remove)
    systemctl disable --now teire-resolver.service docker-resolver.service 2>/dev/null || true
    /usr/local/lib/teire-resolver/firewall.sh down || true
    rm -f /etc/systemd/system/docker-resolver.service /etc/systemd/system/teire-resolver.service \
      /etc/systemd/system/teire-resolver.slice
    systemctl daemon-reload
    check
    ;;
  *) echo "usage: $0 install|remove" >&2; exit 2 ;;
esac
