#!/usr/bin/env bash
# Pass a normal SSH config host alias. Configure the actual Vast address/port
# and identity in ~/.ssh/config; no keys or addresses are committed here.
set -euo pipefail
if [[ $# != 1 || ! "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo 'Usage: bash gpu/tunnel.sh SSH_CONFIG_ALIAS' >&2
  exit 1
fi
exec ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes \
  -L 127.0.0.1:8080:127.0.0.1:8080 "$1"
