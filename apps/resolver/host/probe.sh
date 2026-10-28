#!/usr/bin/env bash
# The isolation probes of THREAT-MODEL.md, run from where a job's containers sit on daemon #2:
#   proxy position   - br-resolver, the only network with a route out (so a block there is the
#                      firewall's doing, not a missing route);
#   updater position - an internal network, as the CLI gives the updater (no route at all).
# Run as root on the host while no job is running (the service clears daemon #2 after each job).
# Prints one line per probe and exits non-zero if any probe shows a hole.
set -u
D=(docker -H unix:///run/docker-resolver.sock)
IMG=alpine:3.22
NET=teire-probe-internal
holes=0

line() { printf '%-4s %-9s %-34s %s\n' "$1" "$2" "$3" "$4"; }

# reach <network> <host> <port>: "open" or "blocked" (3-second TCP connect from a fresh container).
reach() {
  "${D[@]}" run --rm --network "$1" "$IMG" sh -c "nc -z -w 3 $2 $3 >/dev/null 2>&1 && echo open || echo blocked" 2>/dev/null
}

expect() { # threat position target want got
  if [ "$5" = "$4" ]; then line ok "$2" "$3" "$5 (threat $1)"; else line HOLE "$2" "$3" "$5, want $4 (threat $1)"; holes=$((holes + 1)); fi
}

"${D[@]}" pull -q "$IMG" >/dev/null
"${D[@]}" network rm "$NET" >/dev/null 2>&1
"${D[@]}" network create --internal "$NET" >/dev/null

# 1 - gVisor, not the host kernel.
kernel="$("${D[@]}" run --rm "$IMG" dmesg 2>/dev/null | head -1)"
case "$kernel" in *gVisor*) line ok kernel "dmesg" "gVisor (threat 1)" ;; *) line HOLE kernel "dmesg" "${kernel:-empty}, want gVisor (threat 1)"; holes=$((holes + 1)) ;; esac

# The proxy position has a route out: the internet answers, so the blocks below are real.
expect "-" proxy "1.1.1.1:443 (internet)" open "$(reach bridge 1.1.1.1 443)"

# 2 - Coolify's apps, Postgres, the worker, cloud metadata.
pg="$(docker ps --format '{{.Names}}' | grep -m1 6cgivvfez576mi0twzkehvgv)"
pg_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$pg" 2>/dev/null | awk '{print $1}')"
expect 2 proxy "10.0.0.1:22 (docker0)" blocked "$(reach bridge 10.0.0.1 22)"
[ -n "$pg_ip" ] && expect 2 proxy "$pg_ip:5432 (Postgres)" blocked "$(reach bridge "$pg_ip" 5432)"
expect 2 proxy "169.254.169.254:80 (metadata)" blocked "$(reach bridge 169.254.169.254 80)"

# 3 - host services: SSH, Coolify's API, this service.
expect 3 proxy "192.168.240.1:22 (host SSH)" blocked "$(reach bridge 192.168.240.1 22)"
expect 3 proxy "192.168.240.1:8000 (Coolify)" blocked "$(reach bridge 192.168.240.1 8000)"
public="$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
expect 3 proxy "$public:8000 (Coolify, public)" blocked "$(reach bridge "$public" 8000)"
expect 3 proxy "10.0.1.1:8787 (resolver service)" blocked "$(reach bridge 10.0.1.1 8787)"

# The updater position reaches nothing at all.
expect 2 updater "1.1.1.1:443 (internet)" blocked "$(reach "$NET" 1.1.1.1 443)"
expect 3 updater "10.0.1.1:8787 (resolver service)" blocked "$(reach "$NET" 10.0.1.1 8787)"

# 4 - DNS settings are read-only.
dns="$("${D[@]}" run --rm "$IMG" sh -c 'echo x >> /etc/resolv.conf 2>&1 && echo writable || echo read-only' 2>/dev/null | tail -1)"
expect 4 any "/etc/resolv.conf" read-only "$dns"

# 6 - the fake API port range is closed to Coolify's own containers.
worker="$(docker ps --format '{{.Names}}' | grep -m1 birm6kb7aueauhojxxdrtxhb)"
if [ -n "$worker" ]; then
  fake="$(docker exec "$worker" node -e "require('net').connect(47000,'192.168.240.1').on('connect',()=>{console.log('open');process.exit()}).on('error',()=>{console.log('blocked');process.exit()}).setTimeout(3000,()=>{console.log('blocked');process.exit()})" 2>/dev/null)"
  expect 6 worker "192.168.240.1:47000 (fake API)" blocked "${fake:-blocked}"
fi

# 7 - the service refuses calls without its secret.
code="$(curl -s -o /dev/null -w '%{http_code}' http://10.0.1.1:8787/health)"
expect 7 host "10.0.1.1:8787/health, no secret" 401 "$code"

"${D[@]}" network rm "$NET" >/dev/null 2>&1
# 14 - nothing left behind on daemon #2 (the probes' own containers were --rm).
left="$("${D[@]}" ps -aq | wc -l | tr -d ' ')"
expect 14 daemon "containers left on daemon #2" 0 "$left"

echo "holes: $holes"
exit "$holes"
