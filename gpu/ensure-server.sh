#!/usr/bin/env bash
# Called over SSH on each connection/reconnection. flock permits one server.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
gpu_root="${SIMPLE_CHAT_GPU_DIR:-/workspace/simple-chat-gpu}"
test -x "$gpu_root/llama.cpp/build/bin/llama-server"
nohup flock -n "$gpu_root/server.lock" bash "$script_dir/serve.sh" </dev/null >/dev/null 2>&1 &
