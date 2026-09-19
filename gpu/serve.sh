#!/usr/bin/env bash
set -euo pipefail
umask 077
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$task_dir/manifest.env"
gpu_dir="${SIMPLE_CHAT_GPU_DIR:-/workspace/simple-chat-gpu}"
port="${SIMPLE_CHAT_GPU_PORT:-8080}"
context="${SIMPLE_CHAT_GPU_CONTEXT:-65536}"
ubatch="${SIMPLE_CHAT_GPU_UBATCH:-128}"
# One slot writes one scene at a time. With 2..8 slots (a research batch, or the bot's pool with the same
# SIMPLE_CHAT_GPU_SLOTS and SIMPLE_CHAT_POOL_TOKENS as the context here) the slots share one KV cache of the context's
# size for the full-attention layers; each slot adds its own sliding-window cache, about 425 MiB at q8.
slots="${SIMPLE_CHAT_GPU_SLOTS:-1}"
[[ "$slots" =~ ^[1-8]$ ]] || { echo 'Use SIMPLE_CHAT_GPU_SLOTS from 1 to 8.' >&2; exit 1; }
unified=(); (( slots == 1 )) || unified=(--kv-unified)
[[ "$port" =~ ^[0-9]+$ && "$context" =~ ^[0-9]+$ && "$ubatch" =~ ^[0-9]+$ ]] || { echo 'Invalid port/context/ubatch.' >&2; exit 1; }
# A shared cache may be larger than one request's context; one slot holds at most 65536.
max_context=65536; (( slots == 1 )) || max_context=131072
(( port > 0 && port <= 65535 && context >= 8192 && context <= max_context )) || exit 1
(( ubatch >= 32 && ubatch <= 512 )) || exit 1
[[ "$(git -C "$gpu_dir/llama.cpp" rev-parse HEAD)" = "$LLAMA_CPP_REVISION" ]] || { echo 'Unexpected llama.cpp revision; rerun bootstrap.' >&2; exit 1; }
[[ -f "$gpu_dir/models/$MODEL_FILE" ]] || { echo 'Run bootstrap first.' >&2; exit 1; }
# Error output is classified in memory; only safe categories and process
# lifecycle events reach disk. Do not enable prompt or JSON payload logging.
# One slot retains its ordinary prefix KV; the optional RAM snapshot cache is off.
ulimit -c 0
echo "Starting $MODEL_ALIAS; context=$context, slots=$slots, loopback port=$port."
exec python3 "$task_dir/server-log.py" "$gpu_dir/server-events.jsonl" -- \
  "$gpu_dir/llama.cpp/build/bin/llama-server" \
  --model "$gpu_dir/models/$MODEL_FILE" --alias "$MODEL_ALIAS" \
  --host 127.0.0.1 --port "$port" --ctx-size "$context" --parallel "$slots" "${unified[@]}" \
  --gpu-layers 99 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 \
  --batch-size 512 --ubatch-size "$ubatch" --jinja --reasoning-format deepseek \
  --chat-template-kwargs '{"enable_thinking":false}' \
  --no-context-shift --cache-ram 0 --no-cache-idle-slots --no-slots \
  --log-verbosity 1 --log-prefix --log-timestamps --log-colors off --no-log-jsonl
