#!/usr/bin/env bash
set -euo pipefail
umask 077
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$task_dir/manifest.env"
gpu_dir="${SIMPLE_CHAT_GPU_DIR:-/workspace/simple-chat-gpu}"
port="${SIMPLE_CHAT_GPU_PORT:-8080}"
# The cells one request may use, matching the bot's SIMPLE_CHAT_CONTEXT_TOKENS.
context="${SIMPLE_CHAT_GPU_CONTEXT:-65536}"
ubatch="${SIMPLE_CHAT_GPU_UBATCH:-128}"
# One slot writes one scene at a time. 2..8 slots are a research batch, or the bot's pool with the same
# SIMPLE_CHAT_GPU_SLOTS. Each slot adds its own sliding-window cache, about 425 MiB at q8.
slots="${SIMPLE_CHAT_GPU_SLOTS:-1}"
[[ "$slots" =~ ^[1-8]$ ]] || { echo 'Use SIMPLE_CHAT_GPU_SLOTS from 1 to 8.' >&2; exit 1; }
# Isolated slots by default: each gets its own `context` cells and nobody can evict anybody. With
# SIMPLE_CHAT_GPU_KV_UNIFIED=true the slots share SIMPLE_CHAT_GPU_POOL cells instead, no slot may take more than
# `context` of them, and the bot's scheduler admits calls by size (SIMPLE_CHAT_GPU_KV_UNIFIED and
# SIMPLE_CHAT_POOL_TOKENS there must say the same).
unified="${SIMPLE_CHAT_GPU_KV_UNIFIED:-false}"
[[ "$unified" = true || "$unified" = false ]] || { echo 'Use SIMPLE_CHAT_GPU_KV_UNIFIED=true or false.' >&2; exit 1; }
pool="${SIMPLE_CHAT_GPU_POOL:-$context}"
[[ "$port" =~ ^[0-9]+$ && "$context" =~ ^[0-9]+$ && "$ubatch" =~ ^[0-9]+$ && "$pool" =~ ^[0-9]+$ ]] || { echo 'Invalid port/context/ubatch/pool.' >&2; exit 1; }
(( port > 0 && port <= 65535 && context >= 8192 && context <= 65536 )) || exit 1
(( ubatch >= 32 && ubatch <= 512 )) || exit 1
cache=()
if [[ "$unified" = true ]]; then
  (( pool >= context && pool <= 262144 )) || { echo 'SIMPLE_CHAT_GPU_POOL must be from the context up to 262144.' >&2; exit 1; }
  ctx_size="$pool"
  cache=(--kv-unified --kv-unified-per-slot "$context")
else
  ctx_size=$(( context * slots ))
  (( ctx_size <= 262144 )) || { echo 'Isolated slots ask for too many cells; lower the context or the slots.' >&2; exit 1; }
  cache=(--no-kv-unified)
fi
# Speculative decoding with the pinned draft model (docs/gpu.md). Off unless asked for.
draft="${SIMPLE_CHAT_GPU_DRAFT:-false}"
[[ "$draft" = true || "$draft" = false ]] || { echo 'Use SIMPLE_CHAT_GPU_DRAFT=true or false.' >&2; exit 1; }
speculative=()
if [[ "$draft" = true ]]; then
  [[ -f "$gpu_dir/models/$DRAFT_FILE" ]] || { echo 'Draft model missing; rerun bootstrap.' >&2; exit 1; }
  speculative=(--spec-draft-model "$gpu_dir/models/$DRAFT_FILE" --spec-type draft-mtp
    --spec-draft-n-max "${SIMPLE_CHAT_GPU_DRAFT_MAX:-3}" --spec-draft-ngl 99)
fi
[[ "$(git -C "$gpu_dir/llama.cpp" rev-parse HEAD)" = "$LLAMA_CPP_REVISION" ]] || { echo 'Unexpected llama.cpp revision; rerun bootstrap.' >&2; exit 1; }
[[ -f "$gpu_dir/models/$MODEL_FILE" ]] || { echo 'Run bootstrap first.' >&2; exit 1; }
# Error output is classified in memory; only safe categories and process
# lifecycle events reach disk. Do not enable prompt or JSON payload logging.
# The optional RAM snapshot cache is off. `--no-cache-idle-slots` is what keeps a pool working: with a shared cache
# llama.cpp otherwise clears an idle slot's cells on every new task, and a person loses their whole story cache while
# they read. Measured on an RX 580: the same load kept the cache with the flag and re-read the history without it.
ulimit -c 0
echo "Starting $MODEL_ALIAS; context=$context, slots=$slots, cells=$ctx_size, unified=$unified, draft=$draft, loopback port=$port."
exec python3 "$task_dir/server-log.py" "$gpu_dir/server-events.jsonl" -- \
  "$gpu_dir/llama.cpp/build/bin/llama-server" \
  --model "$gpu_dir/models/$MODEL_FILE" --alias "$MODEL_ALIAS" \
  --host 127.0.0.1 --port "$port" --ctx-size "$ctx_size" --parallel "$slots" "${cache[@]}" "${speculative[@]}" \
  --gpu-layers 99 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 \
  --batch-size 512 --ubatch-size "$ubatch" --jinja --reasoning-format deepseek \
  --chat-template-kwargs '{"enable_thinking":false}' \
  --no-context-shift --cache-ram 0 --no-cache-idle-slots --no-slots \
  --log-verbosity 1 --log-prefix --log-timestamps --log-colors off --no-log-jsonl
