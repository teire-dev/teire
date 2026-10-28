#!/bin/sh
# Network for the resolver daemon (plan D93). That daemon runs with iptables off so it never
# touches the rules Coolify's daemon owns; this script is the only thing that writes rules for it.
#   192.168.240.1/24  br-resolver: the default bridge; the fake API and host-gateway live here
#   192.168.224.0/20  networks the dependabot CLI creates per job (default-address-pools)
# Resolver traffic may reach the internet only. Coolify's networks, other private ranges, the
# metadata address and every host port except the fake API's are dropped.
set -eu
NET=192.168.224.0/19
GW=192.168.240.1
FAKE_API_PORTS=47000:47099
WAN=$(ip route show default | awk '{for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1); exit}')

# Each chain is built under a new name, then swapped in for the old one, so there is no moment
# when a jump points at an empty or half-built chain.
swap() { # table chain parent jump-match...
  table=$1 chain=$2 parent=$3
  shift 3
  if iptables -t "$table" -C "$parent" "$@" -j "$chain" 2>/dev/null; then
    iptables -t "$table" -I "$parent" 1 "$@" -j "$chain-NEW"
    iptables -t "$table" -D "$parent" "$@" -j "$chain"
    iptables -t "$table" -F "$chain" && iptables -t "$table" -X "$chain"
  else
    iptables -t "$table" -I "$parent" 1 "$@" -j "$chain-NEW"
  fi
  iptables -t "$table" -E "$chain-NEW" "$chain"
}

fresh() { # table chain
  iptables -t "$1" -F "$2-NEW" 2>/dev/null && iptables -t "$1" -X "$2-NEW" 2>/dev/null || true
  iptables -t "$1" -N "$2-NEW"
}

up() {
  ip link show br-resolver >/dev/null 2>&1 || ip link add br-resolver type bridge
  ip addr replace "$GW/24" dev br-resolver
  ip link set br-resolver up

  fresh filter TEIRE-RESOLVER
  C=TEIRE-RESOLVER-NEW
  iptables -A $C -d "$NET" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -A $C -s "$NET" -d "$NET" -m physdev --physdev-is-bridged -j ACCEPT
  for dst in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
    iptables -A $C -s "$NET" -d "$dst" -j DROP
  done
  iptables -A $C -s "$NET" -o "$WAN" -j ACCEPT
  iptables -A $C -s "$NET" -j DROP
  iptables -A $C -d "$NET" -j DROP
  iptables -N DOCKER-USER 2>/dev/null || true
  iptables -C FORWARD -j DOCKER-USER 2>/dev/null || iptables -I FORWARD 1 -j DOCKER-USER
  swap filter TEIRE-RESOLVER DOCKER-USER

  # Host ports: a resolver container reaches only the fake API ports on the bridge address, and
  # nothing outside the resolver range reaches those ports at all.
  fresh filter TEIRE-RESOLVER-IN
  C=TEIRE-RESOLVER-IN-NEW
  iptables -A $C -s "$NET" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -A $C -s "$NET" -d "$GW" -p tcp --dport "$FAKE_API_PORTS" -j ACCEPT
  iptables -A $C -s "$NET" -j DROP
  iptables -A $C ! -s "$NET" -d "$GW" -p tcp --dport "$FAKE_API_PORTS" -j DROP
  if iptables -C INPUT -s "$NET" -j TEIRE-RESOLVER-IN 2>/dev/null; then
    # An older install jumped only for resolver sources: new jump first, then the old one goes.
    iptables -I INPUT 1 -j TEIRE-RESOLVER-IN-NEW
    iptables -D INPUT -s "$NET" -j TEIRE-RESOLVER-IN
    iptables -F TEIRE-RESOLVER-IN && iptables -X TEIRE-RESOLVER-IN
    iptables -E TEIRE-RESOLVER-IN-NEW TEIRE-RESOLVER-IN
  else
    swap filter TEIRE-RESOLVER-IN INPUT
  fi

  fresh nat TEIRE-RESOLVER-NAT
  iptables -t nat -A TEIRE-RESOLVER-NAT-NEW -s "$NET" -o "$WAN" -j MASQUERADE
  swap nat TEIRE-RESOLVER-NAT POSTROUTING
}

down() {
  iptables -D DOCKER-USER -j TEIRE-RESOLVER 2>/dev/null || true
  iptables -F TEIRE-RESOLVER 2>/dev/null && iptables -X TEIRE-RESOLVER || true
  iptables -D INPUT -s "$NET" -j TEIRE-RESOLVER-IN 2>/dev/null || true
  iptables -D INPUT -j TEIRE-RESOLVER-IN 2>/dev/null || true
  iptables -F TEIRE-RESOLVER-IN 2>/dev/null && iptables -X TEIRE-RESOLVER-IN || true
  iptables -t nat -D POSTROUTING -j TEIRE-RESOLVER-NAT 2>/dev/null || true
  iptables -t nat -F TEIRE-RESOLVER-NAT 2>/dev/null && iptables -t nat -X TEIRE-RESOLVER-NAT || true
  ip link del br-resolver 2>/dev/null || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
