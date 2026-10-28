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

up() {
  ip link show br-resolver >/dev/null 2>&1 || ip link add br-resolver type bridge
  ip addr replace "$GW/24" dev br-resolver
  ip link set br-resolver up

  iptables -N TEIRE-RESOLVER 2>/dev/null || iptables -F TEIRE-RESOLVER
  iptables -A TEIRE-RESOLVER -d "$NET" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -A TEIRE-RESOLVER -s "$NET" -d "$NET" -m physdev --physdev-is-bridged -j ACCEPT
  for dst in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
    iptables -A TEIRE-RESOLVER -s "$NET" -d "$dst" -j DROP
  done
  iptables -A TEIRE-RESOLVER -s "$NET" -o "$WAN" -j ACCEPT
  iptables -A TEIRE-RESOLVER -s "$NET" -j DROP
  iptables -A TEIRE-RESOLVER -d "$NET" -j DROP
  iptables -N DOCKER-USER 2>/dev/null || true
  iptables -C DOCKER-USER -j TEIRE-RESOLVER 2>/dev/null || iptables -I DOCKER-USER 1 -j TEIRE-RESOLVER
  iptables -C FORWARD -j DOCKER-USER 2>/dev/null || iptables -I FORWARD 1 -j DOCKER-USER

  iptables -N TEIRE-RESOLVER-IN 2>/dev/null || iptables -F TEIRE-RESOLVER-IN
  iptables -A TEIRE-RESOLVER-IN -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -A TEIRE-RESOLVER-IN -d "$GW" -p tcp --dport "$FAKE_API_PORTS" -j ACCEPT
  iptables -A TEIRE-RESOLVER-IN -j DROP
  iptables -C INPUT -s "$NET" -j TEIRE-RESOLVER-IN 2>/dev/null || iptables -I INPUT 1 -s "$NET" -j TEIRE-RESOLVER-IN

  iptables -t nat -N TEIRE-RESOLVER-NAT 2>/dev/null || iptables -t nat -F TEIRE-RESOLVER-NAT
  iptables -t nat -A TEIRE-RESOLVER-NAT -s "$NET" -o "$WAN" -j MASQUERADE
  iptables -t nat -C POSTROUTING -j TEIRE-RESOLVER-NAT 2>/dev/null || iptables -t nat -I POSTROUTING 1 -j TEIRE-RESOLVER-NAT
}

down() {
  iptables -D DOCKER-USER -j TEIRE-RESOLVER 2>/dev/null || true
  iptables -F TEIRE-RESOLVER 2>/dev/null && iptables -X TEIRE-RESOLVER || true
  iptables -D INPUT -s "$NET" -j TEIRE-RESOLVER-IN 2>/dev/null || true
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
