#!/bin/sh
# The stop rule (plan D93): what Coolify needs from this host must still work. Exit 0 only when:
#   - a Coolify app container (the Teire worker) reaches DNS, the internet and Postgres;
#   - Coolify itself reaches the host's SSH through host.docker.internal (how it deploys);
#   - docker0, the default bridge of Coolify's daemon, still has its address;
#   - Coolify's API answers.
# The resolver daemon once deleted docker0 on restart (moby removes it by name when
# default-address-pools is set and live-restore is off), and only the SSH check saw it.
# Always Coolify's own daemon, whatever DOCKER_HOST the caller has set.
export DOCKER_HOST=unix:///var/run/docker.sock
fail=0
if docker info >/dev/null 2>&1; then echo "docker ok"; else echo "docker FAIL"; fail=1; fi
if ip -4 addr show docker0 2>/dev/null | grep -q "inet "; then echo "docker0 ok"; else echo "docker0 FAIL"; fail=1; fi
if ! docker ps --format "{{.Names}}" | grep -qx coolify; then
  echo "no Coolify on this host: its checks are skipped"
  exit $fail
fi
# An app container Coolify runs (Teire's worker by default): DNS, the internet, Postgres.
name="${TEIRE_CHECK_CONTAINER:-birm6kb7aueauhojxxdrtxhb}"
c=$(docker ps --filter "name=$name" --format "{{.Names}}" | head -1)
if [ -z "$c" ]; then echo "worker FAIL no container"; fail=1; else
docker exec "$c" node -e '
const dns=require("dns").promises, net=require("net");
(async()=>{
  const out=[];
  try{await dns.lookup("github.com");out.push("dns ok")}catch(e){out.push("dns FAIL "+e.code)}
  try{const r=await fetch("https://api.github.com/zen",{signal:AbortSignal.timeout(10000)});out.push("internet "+(r.status<500?"ok"+(r.ok?"":" ("+r.status+": GitHub answered, so the route works)"):"FAIL "+r.status))}catch(e){out.push("internet FAIL "+e.message)}
  await new Promise(res=>{const s=net.connect(5432,"6cgivvfez576mi0twzkehvgv");s.setTimeout(5000);s.on("connect",()=>{out.push("postgres ok");s.destroy();res()});s.on("error",e=>{out.push("postgres FAIL "+e.code);res()});s.on("timeout",()=>{out.push("postgres FAIL timeout");s.destroy();res()})});
  console.log(out.join("; ")); process.exit(out.some(x=>x.includes("FAIL"))?1:0);
})()' || fail=1
fi
if docker exec coolify nc -z -w5 host.docker.internal 22; then echo "coolify ssh ok"; else echo "coolify ssh FAIL"; fail=1; fi
code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/health)
if [ "$code" = 200 ]; then echo "coolify api ok"; else echo "coolify api FAIL $code"; fail=1; fi
exit $fail
