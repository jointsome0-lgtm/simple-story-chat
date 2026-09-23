#!/usr/bin/env bash
# Called over SSH on each connection/reconnection. flock permits one server.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
gpu_root="${SIMPLE_CHAT_GPU_DIR:-/workspace/simple-chat-gpu}"
test -x "$gpu_root/llama.cpp/build/bin/llama-server"
# A measurement session owns the server: gpu/measure-profile.sh writes this marker and starts serve.sh with one
# profile's environment. Here the environment is empty, so a start would put the default one-slot server under the
# profile's name in the measurer's report. While the marker is valid a reconnect only forwards the port.
#
# The marker names the moment it stops being believed, and the session renews it at every profile start. An
# interrupted session cannot remove its own marker, and a bot that never starts a server again — silently, on a
# machine paid by the minute — is worse than one spoiled measurement. Both paths say so out loud: this output goes
# over SSH to whoever ran the script, and the bot only looks for its readiness token in it.
marker="$gpu_root/measuring.profile"
if [[ -e "$marker" ]]; then
  valid_until=
  while read -r line; do [[ "$line" = until=* ]] && valid_until="${line#until=}"; done <"$marker"
  if [[ "$valid_until" =~ ^[0-9]+$ ]] && (( valid_until > EPOCHSECONDS )); then
    echo "A measurement holds the server ($marker); 'bash gpu/measure-profile.sh --release' gives it back."
    exit 0
  fi
  echo "Ignoring an expired measurement marker ($marker) and starting the server."
  rm -f "$marker"
fi
nohup flock -n "$gpu_root/server.lock" bash "$script_dir/serve.sh" </dev/null >/dev/null 2>&1 &
