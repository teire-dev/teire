#!/bin/sh
# The OCI runtime of the resolver daemon: runsc, with two adjustments for the dependabot CLI.
#
# 1. DNS (`create`). Containers on Docker networks get nameserver 127.0.0.11, Docker's embedded DNS,
#    which listens outside the gVisor sandbox where gVisor's network stack can't reach it
#    (google/gvisor#7469). No resolver container needs container names: the updater reaches the
#    proxy by IP and the proxy reaches the CLI's API through /etc/hosts. So /etc/resolv.conf is
#    mounted read-only from /etc/teire-resolver/resolv.conf (public resolvers): one file shared by
#    every job, which no job may change. Only the proxy has a route out (the updater's network is
#    internal), and the host firewall limits it to the internet.
#
# 2. Working directory (`exec`). runc enters an exec's working directory before it drops
#    capabilities; gVisor resolves it with the exec's own credentials. The CLI runs
#    `update-ca-certificates` as root with every capability dropped, in the image's WORKDIR under
#    /home/dependabot (0750, owned by dependabot): runc gets in, gVisor refuses. For execs as
#    uid 0 whose working directory is under /home, it becomes /, which root can always enter.
#
# Every other call reaches runsc unchanged.
set -eu
RUNSC=${TEIRE_RUNSC:-/usr/local/bin/runsc}
RESOLV=${TEIRE_RESOLV:-/etc/teire-resolver/resolv.conf}

# Flags (runsc's global ones, and create/exec's) whose value is the next argument, as the containerd
# shim passes them (`--root /run/…`, `--log-format json`, `--bundle /run/…`, `--process /tmp/…`).
takes_value() {
  case "$1" in
    --root | --log | --log-format | --debug-log | --panic-log | --platform | --network | --overlay2 | \
      --bundle | -b | --pid-file | --console-socket | --process | -p | --user | -u | --cwd | \
      --cgroup-parent | --detach-keys | --user-log) return 0 ;;
  esac
  return 1
}

cmd=""
process=""
bundle="."
pending=""
for arg in "$@"; do
  if [ -n "$pending" ]; then
    case "$pending" in
      --bundle | -b) bundle=$arg ;;
      --process | -p) process=$arg ;;
    esac
    pending=""
    continue
  fi
  case "$arg" in
    --bundle=* | -b=*) bundle=${arg#*=} ;;
    --process=* | -p=*) process=${arg#*=} ;;
    -*=*) ;;
    -*) takes_value "$arg" && pending=$arg ;;
    # The subcommand is the first word that is neither a flag nor a flag's value.
    *) [ -n "$cmd" ] || cmd=$arg ;;
  esac
done

rewrite() { # file jq-filter
  tmp="$1.teire"
  jq "$2" "$1" >"$tmp" && mv "$tmp" "$1"
}

if [ "$cmd" = create ] && [ -f "$bundle/config.json" ] && [ -f "$RESOLV" ]; then
  rewrite "$bundle/config.json" \
    "(.mounts[]? | select(.destination == \"/etc/resolv.conf\")) |= (.source = \"$RESOLV\" | .options = (((.options // []) - [\"rw\"]) + [\"ro\"] | unique))"
fi

if [ "$cmd" = exec ] && [ -n "$process" ] && [ -f "$process" ] &&
  jq -e '.user.uid == 0 and ((.cwd // "") | startswith("/home/"))' "$process" >/dev/null 2>&1; then
  rewrite "$process" '.cwd = "/"'
fi

exec "$RUNSC" "$@"
