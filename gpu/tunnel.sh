#!/usr/bin/env bash
# Pass a normal SSH config host alias. Configure the actual Vast address/port
# and identity in ~/.ssh/config; no keys or addresses are committed here.
#
# `--pictures` forwards the picture lane's port as well. gpu/image-serve.sh binds ComfyUI to loopback on the rented
# machine and local/image-batch.ts refuses any root that is not loopback here, so without this forwarding the two
# ends cannot meet and the batch is run through an ssh line nobody wrote down. Off by default: the language lane
# needs one port, and a forwarding that fails takes the whole tunnel with it (ExitOnForwardFailure).
set -euo pipefail
pictures=false
if [[ "${1-}" = --pictures ]]; then pictures=true; shift; fi
if [[ $# != 1 || ! "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo 'Usage: bash gpu/tunnel.sh [--pictures] SSH_CONFIG_ALIAS' >&2
  exit 1
fi
# The defaults of SIMPLE_CHAT_GPU_PORT (gpu/serve.sh) and SIMPLE_CHAT_IMAGE_PORT (gpu/image-serve.sh), on the same
# number at both ends: local/gpu-connection.ts and local/image-batch.ts both look for them on 127.0.0.1 here.
image=()
[[ "$pictures" = false ]] || image=(-L 127.0.0.1:8188:127.0.0.1:8188)
exec ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes \
  -L 127.0.0.1:8080:127.0.0.1:8080 ${image[@]+"${image[@]}"} "$1"
