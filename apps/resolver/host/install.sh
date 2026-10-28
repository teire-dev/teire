#!/bin/sh
# Installs the resolver daemon on the Coolify host (plan D93). Run as root from this folder.
# The stop rule: Coolify must reach DNS, the internet and Postgres before and after; if not,
# `./install.sh remove` takes everything out again.
set -eu
cd "$(dirname "$0")"
check() { /usr/local/sbin/teire-coolify-check; }

case "${1:-install}" in
  install)
    check
    install -d /etc/teire-resolver /usr/local/lib/teire-resolver
    install -m 0644 daemon.json /etc/teire-resolver/daemon.json
    install -m 0755 firewall.sh /usr/local/lib/teire-resolver/firewall.sh
    install -m 0644 teire-resolver.slice docker-resolver.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now docker-resolver.service
    check
    ;;
  remove)
    systemctl disable --now docker-resolver.service 2>/dev/null || true
    /usr/local/lib/teire-resolver/firewall.sh down || true
    rm -f /etc/systemd/system/docker-resolver.service /etc/systemd/system/teire-resolver.slice
    systemctl daemon-reload
    check
    ;;
  *) echo "usage: $0 install|remove" >&2; exit 2 ;;
esac
