#!/bin/sh
# The OCI runtime of the resolver daemon: runsc, with one difference for `exec`.
#
# runc enters an exec's working directory before it drops capabilities; gVisor resolves it with
# the exec's own credentials. The dependabot CLI runs `update-ca-certificates` as root with every
# capability dropped, in the image's WORKDIR under /home/dependabot (mode 0750, owned by
# dependabot): runc gets in, gVisor refuses ("failed to find initial working directory").
# For execs as uid 0 whose working directory is under /home, this sets it to /, which root can
# always enter. Every other call reaches runsc unchanged.
set -eu
RUNSC=/usr/local/bin/runsc

is_exec=0
process=""
prev=""
for arg in "$@"; do
  case "$arg" in
    exec) [ -z "$process" ] && is_exec=1 ;;
    --process=*) process=${arg#--process=} ;;
  esac
  [ "$prev" = "--process" ] && process=$arg
  prev=$arg
done

if [ "$is_exec" = 1 ] && [ -n "$process" ] && [ -f "$process" ]; then
  if jq -e '.user.uid == 0 and ((.cwd // "") | startswith("/home/"))' "$process" >/dev/null 2>&1; then
    tmp="$process.teire"
    jq '.cwd = "/"' "$process" >"$tmp" && mv "$tmp" "$process"
  fi
fi
exec "$RUNSC" "$@"
