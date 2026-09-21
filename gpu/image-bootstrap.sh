#!/usr/bin/env bash
# Prepare the picture card inside the rented CUDA container, never on the bot host: pinned ComfyUI, pinned torch,
# weights verified by size and SHA256. Meant to run beside bootstrap.sh, which builds llama.cpp on the language
# card; both lanes share one link, so the speed floor below is read once, here, while the compiler is busy.
#
# Tokens: the CivitAI file and the gated Krea repository need one each. They arrive in SIMPLE_CHAT_CIVITAI_TOKEN /
# SIMPLE_CHAT_HF_TOKEN, or as `civitai=...` / `hf=...` lines on stdin with --tokens-stdin. They are never written to
# disk, never echoed and never passed as an argument: curl reads the Authorization header from its stdin config, so
# `ps` shows nothing. A token is only ever sent to the host in the pinned URL; curl drops it across a redirect to a
# CDN, which is what we want, because the signed CDN link needs no credential.
set -euo pipefail
umask 077
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$task_dir/image-manifest.env"
gpu_dir="${SIMPLE_CHAT_GPU_DIR:-/workspace/simple-chat-gpu}"
[[ "$gpu_dir" = /* && "$gpu_dir" != / ]] || { echo 'Use an absolute SIMPLE_CHAT_GPU_DIR.' >&2; exit 1; }
comfy_dir="$gpu_dir/ComfyUI"
models_dir="$comfy_dir/models"
# `comfy` takes the encoder and the VAE from the public ComfyUI repackaging, `official` from the gated Krea
# repository (see image-manifest.env: its hashes have to be filled in first).
image_source="${SIMPLE_CHAT_IMAGE_SOURCE:-comfy}"
[[ "$image_source" = comfy || "$image_source" = official ]] || { echo 'Use SIMPLE_CHAT_IMAGE_SOURCE=comfy or official.' >&2; exit 1; }
# The comparison checkpoint is 13 GB and only earns its place if the fine-tune disappoints; it is still on by
# default, because deciding that at minute 50 of a rental is too late to download it.
turbo="${SIMPLE_CHAT_IMAGE_TURBO:-true}"
[[ "$turbo" = true || "$turbo" = false ]] || { echo 'Use SIMPLE_CHAT_IMAGE_TURBO=true or false.' >&2; exit 1; }
# An offer that advertises 1171 Mbit/s has delivered 115 (docs/gpu.md). Below the floor the answer is to destroy the
# machine and take the next candidate, not to wait: 22 GB at 100 Mbit/s is half the session.
min_mbit="${SIMPLE_CHAT_IMAGE_MIN_MBIT:-200}"
window="${SIMPLE_CHAT_IMAGE_SPEED_WINDOW:-60}"
[[ "$min_mbit" =~ ^[0-9]+$ && "$window" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid SIMPLE_CHAT_IMAGE_MIN_MBIT/WINDOW.' >&2; exit 1; }
for command in git curl python3; do
  command -v "$command" >/dev/null || { echo "Missing dependency: $command (use a CUDA development image)." >&2; exit 1; }
done

dry_run=false
tokens_stdin=false
print_workflow=false
for argument in "$@"; do
  case "$argument" in
    # Everything that costs nothing: the pins, the tokens, the leftovers and the plan, without a byte downloaded.
    --dry-run) dry_run=true ;;
    --tokens-stdin) tokens_stdin=true ;;
    # The graph this run would post, with the file names of the chosen source filled in.
    --print-workflow) print_workflow=true ;;
    *) echo 'Usage: image-bootstrap.sh [--dry-run] [--tokens-stdin] [--print-workflow]' >&2; exit 1 ;;
  esac
done

civitai_token="${SIMPLE_CHAT_CIVITAI_TOKEN:-}"
hf_token="${SIMPLE_CHAT_HF_TOKEN:-}"
if [[ "$tokens_stdin" = true ]]; then
  # `|| [[ -n "$line" ]]`: the natural way to pipe a secret is `printf 'civitai=%s' "$t"`, without a closing
  # newline, and a plain `read` loop would drop that last line and report a missing token instead.
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      civitai=*) civitai_token="${line#civitai=}" ;;
      hf=*) hf_token="${line#hf=}" ;;
      '') ;;
      # The offending line is not repeated: it holds a secret.
      *) echo 'On stdin use lines "civitai=<token>" and "hf=<token>", one per line.' >&2; exit 1 ;;
    esac
  done
fi

# One record per file: URL, destination, SHA256, size, which token to send.
records=()
add_record() { records+=("$1"$'\t'"$2"$'\t'"$3"$'\t'"$4"$'\t'"$5"); }
hf_url() { printf 'https://huggingface.co/%s/resolve/%s/%s' "$1" "$2" "$3"; }
add_record "$IMAGE_MODEL_URL" "$models_dir/diffusion_models/$IMAGE_MODEL_FILE" "$IMAGE_MODEL_SHA256" "$IMAGE_MODEL_BYTES" civitai
# The two file names the graph's loaders have to name: `official` installs different ones, and a graph that kept
# the `comfy` names would fail inside CLIPLoader on a box that passed every check here.
if [[ "$image_source" = official ]]; then
  encoder_file="$OFFICIAL_ENCODER_FILE"; vae_file="$OFFICIAL_VAE_FILE"
  add_record "$(hf_url "$OFFICIAL_REPO" "$OFFICIAL_REVISION" "$OFFICIAL_ENCODER_PATH")" \
    "$models_dir/text_encoders/$OFFICIAL_ENCODER_FILE" "$OFFICIAL_ENCODER_SHA256" "$OFFICIAL_ENCODER_BYTES" hf
  add_record "$(hf_url "$OFFICIAL_REPO" "$OFFICIAL_REVISION" "$OFFICIAL_VAE_PATH")" \
    "$models_dir/vae/$OFFICIAL_VAE_FILE" "$OFFICIAL_VAE_SHA256" "$OFFICIAL_VAE_BYTES" hf
  [[ "$turbo" = false ]] || add_record "$(hf_url "$OFFICIAL_REPO" "$OFFICIAL_REVISION" "$OFFICIAL_TURBO_PATH")" \
    "$models_dir/diffusion_models/$OFFICIAL_TURBO_FILE" "$OFFICIAL_TURBO_SHA256" "$OFFICIAL_TURBO_BYTES" hf
else
  encoder_file="$IMAGE_ENCODER_FILE"; vae_file="$IMAGE_VAE_FILE"
  add_record "$(hf_url "$IMAGE_ENCODER_REPO" "$IMAGE_ENCODER_REVISION" "$IMAGE_ENCODER_PATH")" \
    "$models_dir/text_encoders/$IMAGE_ENCODER_FILE" "$IMAGE_ENCODER_SHA256" "$IMAGE_ENCODER_BYTES" none
  add_record "$(hf_url "$IMAGE_VAE_REPO" "$IMAGE_VAE_REVISION" "$IMAGE_VAE_PATH")" \
    "$models_dir/vae/$IMAGE_VAE_FILE" "$IMAGE_VAE_SHA256" "$IMAGE_VAE_BYTES" none
  [[ "$turbo" = false ]] || add_record "$(hf_url "$IMAGE_TURBO_REPO" "$IMAGE_TURBO_REVISION" "$IMAGE_TURBO_PATH")" \
    "$models_dir/diffusion_models/$IMAGE_TURBO_FILE" "$IMAGE_TURBO_SHA256" "$IMAGE_TURBO_BYTES" none
fi

# The pinned graph names the `comfy` files; this fills in what this run installs, so `official` is posted with the
# file names it downloaded. Whether ComfyUI's loaders read the official diffusers layout at all is still unverified.
render_workflow() {
  python3 - "$task_dir/$IMAGE_WORKFLOW" "$IMAGE_MODEL_FILE" "$encoder_file" "$vae_file" <<'PY'
import json,sys
graph=json.load(open(sys.argv[1]))
widgets={'UNETLoader':('unet_name',sys.argv[2]),'CLIPLoader':('clip_name',sys.argv[3]),'VAELoader':('vae_name',sys.argv[4])}
for node in graph.values():
    widget=widgets.get(node['class_type'])
    if widget: node['inputs'][widget[0]]=widget[1]
json.dump(graph,sys.stdout,indent=2)
print()
PY
}
[[ "$print_workflow" = false ]] || { render_workflow; exit 0; }

total_bytes=0
for record in "${records[@]}"; do
  IFS=$'\t' read -r url destination digest size auth <<<"$record"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { echo "No pinned SHA256 for $(basename -- "$destination"); fill it into image-manifest.env." >&2; exit 1; }
  [[ "$size" =~ ^[1-9][0-9]*$ ]] || { echo "No pinned size for $(basename -- "$destination")." >&2; exit 1; }
  [[ "$auth" != civitai || -n "$civitai_token" ]] || { echo 'A CivitAI API token is required: SIMPLE_CHAT_CIVITAI_TOKEN or --tokens-stdin.' >&2; exit 1; }
  [[ "$auth" != hf || -n "$hf_token" ]] || { echo 'A Hugging Face token with access to the gate is required: SIMPLE_CHAT_HF_TOKEN or --tokens-stdin.' >&2; exit 1; }
  # A leftover longer than the pinned file is not this file and can only be thrown away. It happens here, before any
  # download and before the speed guard takes its first sample: deleting it beside the running guard would show the
  # directory shrinking, and the guard would read that as a negative rate and end every download.
  python3 - "$destination.part" "$size" <<'PY'
import pathlib,sys
part=pathlib.Path(sys.argv[1])
if part.exists() and part.stat().st_size > int(sys.argv[2]):
    part.unlink(); print(f'{part.name}: a leftover longer than the pinned file was discarded.')
PY
  # A file already on disk needs no room for itself; a partial one is counted whole, on the safe side.
  [[ -f "$destination" ]] || total_bytes=$(( total_bytes + size ))
done
# The tokens travel inside a quoted curl config line; a quote or a backslash in one would end the quoting early.
for token in "$civitai_token" "$hf_token"; do
  [[ "$token" != *[\"\\]* ]] || { echo 'A token contains a quote or a backslash and cannot be passed this way.' >&2; exit 1; }
done
if [[ "$dry_run" = true ]]; then
  echo "Source $image_source, $(( total_bytes / 1024**3 )) GiB to fetch:"
  for record in "${records[@]}"; do
    IFS=$'\t' read -r url destination digest size auth <<<"$record"
    printf '%s\t%s bytes\t%s\n' "$(basename -- "$destination")" "$size" "$([[ -f "$destination" ]] && echo present || echo 'to fetch')"
  done
  echo "The graph would load $IMAGE_MODEL_FILE, $encoder_file and $vae_file; --print-workflow prints it."
  exit 0
fi

command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader
mkdir -p "$models_dir/diffusion_models" "$models_dir/text_encoders" "$models_dir/vae"
# The weights plus the virtual environment: torch with its CUDA libraries is about 12 GB on disk.
python3 - "$gpu_dir" "$total_bytes" <<'PY'
import pathlib,shutil,sys
required=int(sys.argv[2])+13*1024**3
free=shutil.disk_usage(pathlib.Path(sys.argv[1])).free
if free < required:
    raise SystemExit(f'At least {required // 1024**3} GiB free disk is required; {free // 1024**3} GiB is free.')
PY

downloaded_bytes() {
  python3 - "$models_dir" <<'PY'
import pathlib,sys
total=0
for path in pathlib.Path(sys.argv[1]).rglob('*'):
    if path.is_file(): total+=path.stat().st_size
print(total)
PY
}

fetch_one() {
  local url="$1" destination="$2" size="$3" auth="$4"
  local part="$destination.part" token='' needed
  # A finished download can survive an interrupted verification, and a partial file can only be resumed from its
  # own end. Nothing is deleted here: an unusable leftover is already gone, discarded before the guard started.
  needed="$(python3 - "$part" "$destination" "$size" <<'PY'
import pathlib,sys
part=pathlib.Path(sys.argv[1]); target=pathlib.Path(sys.argv[2]); expected=int(sys.argv[3])
done=target.exists() or (part.exists() and part.stat().st_size == expected)
print('no' if done else 'yes')
PY
)"
  [[ "$needed" = yes ]] || return 0
  case "$auth" in civitai) token="$civitai_token" ;; hf) token="$hf_token" ;; esac
  # The URL, the output path and the credential go to curl over stdin, so none of them can be read out of `ps`.
  {
    printf 'url = "%s"\n' "$url"
    printf 'output = "%s"\n' "$part"
    if [[ -n "$token" ]]; then printf 'header = "Authorization: Bearer %s"\n' "$token"; fi
    printf '\n'
  } | curl --config - --continue-at - --fail --location --silent --show-error --retry 5 --retry-delay 5 &
  local curl_pid=$!
  # The speed guard kills this subshell; pass that on to curl instead of orphaning a download that keeps the link busy.
  trap 'kill "$curl_pid" 2>/dev/null || true' TERM
  wait "$curl_pid"
}

# Measures the shared link once the downloads are running and ends them if the machine cannot deliver.
speed_guard() {
  local before after mbit pid alive=false
  before="$(downloaded_bytes)"
  sleep "$window"
  after="$(downloaded_bytes)"
  # While the fetchers run the directory only grows. If it shrank anyway, something outside this script is at work
  # and the average is not evidence; a negative rate is never a reason to destroy a machine.
  if (( after < before )); then
    echo 'The weights directory shrank during the measurement; the link was not judged.' >&2
    return 0
  fi
  mbit=$(( (after - before) * 8 / window / 1000000 ))
  for pid in "${download_pids[@]}"; do kill -0 "$pid" 2>/dev/null && alive=true; done
  # Everything already arrived inside the window: the average is meaningless and there is nothing left to end.
  if [[ "$alive" = false ]] || (( mbit >= min_mbit )); then
    echo "Weights arriving at about ${mbit} Mbit/s."
    return 0
  fi
  echo "Only ${mbit} Mbit/s over ${window}s, below the ${min_mbit} Mbit/s floor: destroy this machine and take the next offer." >&2
  kill "${download_pids[@]}" 2>/dev/null || true
}

download_pids=()
for record in "${records[@]}"; do
  IFS=$'\t' read -r url destination digest size auth <<<"$record"
  fetch_one "$url" "$destination" "$size" "$auth" &
  download_pids+=($!)
done
speed_guard &
guard_pid=$!

# Meanwhile the environment is built, so the link and the installer do not wait for each other.
if [[ ! -d "$comfy_dir/.git" ]]; then
  git init -q "$comfy_dir"
  git -C "$comfy_dir" remote add origin "$COMFYUI_REPO"
fi
[[ "$(git -C "$comfy_dir" remote get-url origin)" = "$COMFYUI_REPO" ]] || { echo 'Unexpected ComfyUI repository.' >&2; exit 1; }
git -C "$comfy_dir" fetch --depth 1 origin "$COMFYUI_REVISION"
git -C "$comfy_dir" checkout --detach "$COMFYUI_REVISION"
[[ "$(git -C "$comfy_dir" rev-parse HEAD)" = "$COMFYUI_REVISION" ]]
[[ -d "$comfy_dir/.venv" ]] || python3 -m venv "$comfy_dir/.venv"
python="$comfy_dir/.venv/bin/python"
"$python" -m pip install --quiet --upgrade pip
# Torch first and pinned, from the CUDA index: ComfyUI's requirements.txt asks for a bare `torch`, and the default
# index would serve a build without sm_120 kernels.
"$python" -m pip install --quiet --index-url "$TORCH_INDEX_URL" \
  "torch==$TORCH_VERSION" "torchvision==$TORCHVISION_VERSION" "torchaudio==$TORCHAUDIO_VERSION"
"$python" -m pip install --quiet -r "$comfy_dir/requirements.txt"
"$python" - "$TORCH_ARCH" <<'PY'
import sys,torch
archs=torch.cuda.get_arch_list()
print(f'torch {torch.__version__}, CUDA {torch.version.cuda}, architectures: {" ".join(archs)}')
if sys.argv[1] not in archs:
    raise SystemExit(f'This torch build has no {sys.argv[1]} kernels; the card would fall back or fail.')
PY
# Nothing here installs a custom node, and image-serve.sh disables the folder anyway; say so if one appeared.
if compgen -G "$comfy_dir/custom_nodes/*/" >/dev/null; then
  echo 'Third-party custom nodes are present in ComfyUI/custom_nodes; they stay disabled at run time.' >&2
fi

failed=0
for pid in "${download_pids[@]}"; do wait "$pid" || failed=1; done
# The guard may still be inside its window; nothing is left for it to measure.
kill "$guard_pid" 2>/dev/null || true
wait "$guard_pid" 2>/dev/null || true
(( failed == 0 )) || { echo 'A download failed or was ended; nothing is verified.' >&2; exit 1; }

for record in "${records[@]}"; do
  IFS=$'\t' read -r url destination digest size auth <<<"$record"
  python3 - "$destination" "$digest" "$size" <<'PY'
import hashlib,pathlib,sys
target=pathlib.Path(sys.argv[1]); current=target if target.exists() else pathlib.Path(str(target)+'.part')
def mismatch(message):
    if current != target: current.unlink()
    raise SystemExit(f'{target.name}: {message}')
if current.stat().st_size != int(sys.argv[3]): mismatch('size mismatch; not starting.')
with current.open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
if digest != sys.argv[2]: mismatch('SHA256 mismatch; not starting.')
if current != target: current.rename(target)
print(f'{target.name}: SHA256 verified.')
PY
done
# The graph is written only once the weights it names are verified, so its presence means the box can render.
render_workflow >"$gpu_dir/$IMAGE_WORKFLOW"
echo "Prepared; post $gpu_dir/$IMAGE_WORKFLOW. Start with: bash $task_dir/image-serve.sh"
