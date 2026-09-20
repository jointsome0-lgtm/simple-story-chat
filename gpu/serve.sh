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
  # The draft's own cache defaults to f16 and does not follow --cache-type-k/v, while its context is stretched to the
  # whole pool: on the measured 5090 that was about 816 MiB, and the pool with the draft model missed fitting by
  # roughly 90. Give it the same q8_0 the target uses. SIMPLE_CHAT_GPU_DRAFT_CACHE=f16 restores the old behaviour.
  draft_cache="${SIMPLE_CHAT_GPU_DRAFT_CACHE:-q8_0}"
  [[ "$draft_cache" =~ ^(f32|f16|bf16|q8_0|q4_0|q4_1|q5_0|q5_1|iq4_nl)$ ]] \
    || { echo 'Use a cache type llama.cpp accepts for SIMPLE_CHAT_GPU_DRAFT_CACHE.' >&2; exit 1; }
  speculative=(--spec-draft-model "$gpu_dir/models/$DRAFT_FILE" --spec-type draft-mtp
    --spec-draft-n-max "${SIMPLE_CHAT_GPU_DRAFT_MAX:-3}" --spec-draft-ngl 99
    --spec-draft-type-k "$draft_cache" --spec-draft-type-v "$draft_cache")
fi
[[ "$(git -C "$gpu_dir/llama.cpp" rev-parse HEAD)" = "$LLAMA_CPP_REVISION" ]] || { echo 'Unexpected llama.cpp revision; rerun bootstrap.' >&2; exit 1; }
[[ -f "$gpu_dir/models/$MODEL_FILE" ]] || { echo 'Run bootstrap first.' >&2; exit 1; }
# Error output is classified in memory; only safe categories and process
# lifecycle events reach disk. Do not enable prompt or JSON payload logging.
# The optional RAM snapshot cache is off. `--no-cache-idle-slots` is what keeps a pool working: with a shared cache
# llama.cpp otherwise clears an idle slot's cells on every new task, and a person loses their whole story cache while
# they read. Measured on an RX 580: the same load kept the cache with the flag and re-read the history without it.
# The default of 1 passes only errors (common/log.h: LOG_LEVEL_ERROR 1), and the server's own account of its memory --
# the size of each cache, its cells, layers and buffers -- is INFO, which is 3. Two rentals were spent deducing those
# numbers by subtraction while the server was willing to state them. Raise this to 3 for a start whose numbers you want
# in `server-events.jsonl`. No level writes a raw line: server-log.py persists categories and whole numbers only.
verbosity="${SIMPLE_CHAT_GPU_LOG_VERBOSITY:-1}"
[[ "$verbosity" =~ ^[1-5]$ ]] || { echo 'Use SIMPLE_CHAT_GPU_LOG_VERBOSITY from 1 to 5.' >&2; exit 1; }
# Host RAM the server may keep slot snapshots in, in MiB. Zero is the old behaviour and the default until the gain is
# measured: with the cache off, a slot that alternates between two prompts -- a person's scene and the compaction of
# their memory -- re-reads the whole history each time. On the measured 5090 that was 41 of the 49 seconds the agent
# spent in prefill. A snapshot holds the KV of somebody's story, so this stays a deliberate number and not -1; the
# server keeps it in memory and writes nothing, since --slot-save-path is never set.
cache_ram="${SIMPLE_CHAT_GPU_CACHE_RAM:-0}"
[[ "$cache_ram" =~ ^[0-9]{1,6}$ ]] || { echo 'Use SIMPLE_CHAT_GPU_CACHE_RAM in whole MiB, 0 to 999999.' >&2; exit 1; }
ulimit -c 0
echo "Starting $MODEL_ALIAS; context=$context, slots=$slots, cells=$ctx_size, unified=$unified, draft=$draft, loopback port=$port."
exec python3 "$task_dir/server-log.py" "$gpu_dir/server-events.jsonl" -- \
  "$gpu_dir/llama.cpp/build/bin/llama-server" \
  --model "$gpu_dir/models/$MODEL_FILE" --alias "$MODEL_ALIAS" \
  --host 127.0.0.1 --port "$port" --ctx-size "$ctx_size" --parallel "$slots" "${cache[@]}" "${speculative[@]}" \
  --gpu-layers 99 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 \
  --batch-size 512 --ubatch-size "$ubatch" --jinja --reasoning-format deepseek \
  --chat-template-kwargs '{"enable_thinking":false}' \
  --no-context-shift --cache-ram "$cache_ram" --no-cache-idle-slots --no-slots \
  --log-verbosity "$verbosity" --log-prefix --log-timestamps --log-colors off --no-log-jsonl
