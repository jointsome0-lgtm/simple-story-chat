#!/usr/bin/env bash
# Pass a normal SSH config host alias. Configure the actual Vast address/port
# and identity in ~/.ssh/config; no keys or addresses are committed here.
#
# `--pictures` forwards the picture lane's port as well. gpu/image-serve.sh binds ComfyUI to loopback on the rented
# machine and local/image-batch.ts refuses any root that is not loopback here, so without this forwarding the two
# ends cannot meet and the batch is run through an ssh line nobody wrote down. Off by default: the language lane
# needs one port, and a forwarding that fails takes the whole tunnel with it (ExitOnForwardFailure).
# `--pictures-only` is for a session on two rented machines, one lane each: the picture machine has no llama-server,
# and the model port on this side already belongs to the tunnel of the other machine.
#
# The tunnel comes back by itself (docs/gpu.md#the-tunnel): a connection that drops, as the picture card's did on
# 2026-09-26, is dialled again two seconds later, for as long as this runs, and the harness waits for it
# (docs/action-experiment.md#dropped-connection). It stops, and says why, only when it can do nothing about the
# cause: a port here that another process holds, which it reports and never kills, or three refusals in a row of the
# key or of the host's key. Ctrl-C, or a TERM to this script, ends ssh with it.
set -euo pipefail
lanes=model
case "${1-}" in --pictures) lanes=both; shift ;; --pictures-only) lanes=pictures; shift ;; esac
if [[ $# != 1 || ! "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo 'Usage: bash gpu/tunnel.sh [--pictures|--pictures-only] SSH_CONFIG_ALIAS' >&2
  exit 1
fi
# The defaults of SIMPLE_CHAT_GPU_PORT (gpu/serve.sh) and SIMPLE_CHAT_IMAGE_PORT (gpu/image-serve.sh), on the same
# number at both ends: local/gpu-connection.ts and local/image-batch.ts both look for them on 127.0.0.1 here.
forward=() ports=()
[[ "$lanes" = pictures ]] || { forward+=(-L 127.0.0.1:8080:127.0.0.1:8080); ports+=(8080); }
[[ "$lanes" = model ]] || { forward+=(-L 127.0.0.1:8188:127.0.0.1:8188); ports+=(8188); }

# ssh runs in the background and is waited for, so that a signal to this script is acted on at once: a background
# child of a non-interactive shell ignores Ctrl-C, and this loop ends it. What ssh says goes to a file of its own and
# is shown once it has exited, to tell a port already taken and a refused key from a dropped connection.
said=$(mktemp "${TMPDIR:-/tmp}/simple-chat-tunnel.XXXXXX")
child=
# Every child is ended, ssh or the pause, one that a signal met before `child=$!` included.
end() {
  trap - INT TERM HUP
  # shellcheck disable=SC2046 # one pid a word; word splitting is the list.
  kill -TERM $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
  exit "$1"
}
trap 'rm -f "$said"' EXIT
trap 'end 130' INT
trap 'end 143' TERM
trap 'end 129' HUP
stamp() { date -u +%H:%M:%SZ; }
refused=0
while :; do
  status=0
  # BatchMode: a key that is refused fails at once instead of asking for a password nobody is there to type.
  # ConnectTimeout bounds a dial into a host that does not answer; the keepalive notices a connection that went quiet
  # after 15 s x 3.
  ssh -N -T -o BatchMode=yes -o ConnectTimeout=10 -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes \
    "${forward[@]}" "$1" 2>"$said" &
  child=$!
  wait "$child" || status=$?
  child=
  if [[ -s "$said" ]]; then cat "$said" >&2; fi
  if ((status == 0)); then exit 0; fi
  # Another process listens on a port this tunnel forwards: an old tunnel, most likely. It is named and left alone.
  if grep -qiE 'Address already in use|cannot listen to port|Could not request local forwarding' "$said"; then
    echo "$(stamp) a port this tunnel forwards (${ports[*]}) is held by another listener here; it is not killed, and the tunnel stops:" >&2
    for port in "${ports[@]}"; do
      if command -v ss >/dev/null; then ss -ltnp "sport = :$port" >&2 || true
      elif command -v lsof >/dev/null; then lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
      fi
    done
    exit 1
  fi
  if grep -qiE 'Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Too many authentication failures' "$said"; then
    refused=$((refused + 1))
    if ((refused >= 3)); then
      echo "$(stamp) $1 refused the key or its host key three times in a row; the tunnel stops" >&2
      exit 1
    fi
  else
    refused=0
  fi
  echo "$(stamp) the tunnel to $1 ended (ssh exit $status); dialling again in 2 s" >&2
  sleep 2 &
  child=$!
  wait "$child" || true
  child=
done
