#!/usr/bin/env bash
# ComfyUI for the picture lane: headless, loopback only, one chosen card, no custom nodes, no SageAttention.
set -euo pipefail
umask 077
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$task_dir/image-manifest.env"
gpu_dir="${SIMPLE_CHAT_GPU_DIR:-/workspace/simple-chat-gpu}"
comfy_dir="$gpu_dir/ComfyUI"
port="${SIMPLE_CHAT_IMAGE_PORT:-8188}"
# Which card the pictures use. The language server takes the whole of its own card (gpu/serve.sh --gpu-layers 99),
# so a picture that lands there means an OOM in the middle of somebody's scene. CUDA_VISIBLE_DEVICES is the only
# switch used here: at the pinned revision `--cuda-device N` is a plain assignment to that same variable
# (main.py:99), so passing both would say the same thing twice, and the choice stays in one place, the environment.
device="${SIMPLE_CHAT_IMAGE_GPU:-1}"
[[ "$port" =~ ^[0-9]+$ && "$device" =~ ^[0-9]$ ]] || { echo 'Use a numeric SIMPLE_CHAT_IMAGE_PORT and a single-digit SIMPLE_CHAT_IMAGE_GPU index.' >&2; exit 1; }
(( port > 0 && port <= 65535 )) || exit 1
[[ -x "$comfy_dir/.venv/bin/python" ]] || { echo 'Run image-bootstrap.sh first.' >&2; exit 1; }
[[ "$(git -C "$comfy_dir" rev-parse HEAD)" = "$COMFYUI_REVISION" ]] || { echo 'Unexpected ComfyUI revision; rerun image-bootstrap.sh.' >&2; exit 1; }
image_source="${SIMPLE_CHAT_IMAGE_SOURCE:-comfy}"
if [[ "$image_source" = official ]]; then
  encoder="$OFFICIAL_ENCODER_FILE"; vae="$OFFICIAL_VAE_FILE"
else
  encoder="$IMAGE_ENCODER_FILE"; vae="$IMAGE_VAE_FILE"
fi
for file in "models/diffusion_models/$IMAGE_MODEL_FILE" "models/text_encoders/$encoder" "models/vae/$vae"; do
  [[ -f "$comfy_dir/$file" ]] || { echo "Missing $file; rerun image-bootstrap.sh." >&2; exit 1; }
done
# image-bootstrap.sh writes this graph with the file names of the source it installed, after verifying them; the bot
# posts it. Without it the server would answer /prompt with loaders pointing at files nobody fetched.
workflow="$gpu_dir/$IMAGE_WORKFLOW"
[[ -f "$workflow" ]] || { echo "Missing $workflow; rerun image-bootstrap.sh." >&2; exit 1; }
grep -q "\"$encoder\"" "$workflow" || { echo "$workflow names another encoder than $image_source installed." >&2; exit 1; }
# The Qwen checkpoint is additive: the same server serves it, from its own three files and its own two graphs. This
# refuses to start with the flag on and the files absent, rather than let the first cell of a timed run find out.
if [[ "${SIMPLE_CHAT_IMAGE_QWEN:-false}" = true ]]; then
  for file in "models/diffusion_models/$IMAGE_QWEN_MODEL_FILE" "models/text_encoders/$IMAGE_QWEN_ENCODER_FILE" "models/vae/$IMAGE_QWEN_VAE_FILE"; do
    [[ -f "$comfy_dir/$file" ]] || { echo "Missing $file; rerun image-bootstrap.sh with SIMPLE_CHAT_IMAGE_QWEN=true." >&2; exit 1; }
  done
  for graph in "$IMAGE_QWEN_WORKFLOW" "$IMAGE_QWEN_EDIT_WORKFLOW"; do
    [[ -f "$gpu_dir/$graph" ]] || { echo "Missing $gpu_dir/$graph; rerun image-bootstrap.sh with SIMPLE_CHAT_IMAGE_QWEN=true." >&2; exit 1; }
  done
fi
# Krea 2 produces garbage under SageAttention, and several rented ComfyUI templates turn it on through their own
# launcher. This script is the launcher: the flag is absent, and an inherited request for it is refused rather than
# silently ignored, because a bad picture would otherwise be blamed on the fine-tune.
if [[ "${COMFYUI_ARGS:-}${CLI_ARGS:-}${COMFYUI_EXTRA_ARGS:-}" = *sage* ]]; then
  echo 'SageAttention is requested in the environment; Krea 2 breaks under it. Clear COMFYUI_ARGS/CLI_ARGS first.' >&2
  exit 1
fi
export CUDA_VISIBLE_DEVICES="$device"
ulimit -c 0
echo "Starting ComfyUI $COMFYUI_VERSION for $IMAGE_MODEL_NAME on GPU $device, loopback port $port; post $workflow."
# --disable-metadata: ComfyUI writes the whole prompt into the PNG by default, and a picture leaves the card.
# --disable-all-custom-nodes and --disable-api-nodes: only the pinned core runs, and nothing calls a paid endpoint.
# --preview-method none: previews cost VRAM on the card the language model does not share.
# The attention implementation is left at the pinned build's default, which is the same on every run of this commit;
# ComfyUI prints which one it chose at startup, and that line belongs with the seconds-per-picture number.
# /history and the output folder hold story text — do not copy them home.
exec "$comfy_dir/.venv/bin/python" "$comfy_dir/main.py" \
  --listen 127.0.0.1 --port "$port" --disable-auto-launch \
  --disable-metadata --disable-all-custom-nodes --disable-api-nodes --preview-method none
