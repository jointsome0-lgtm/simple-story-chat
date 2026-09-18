#!/usr/bin/env bash
# Run inside the rented CUDA development container, never on the bot host.
set -euo pipefail
umask 077
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$task_dir/manifest.env"
gpu_dir="${SIMPLE_CHAT_GPU_DIR:-/workspace/simple-chat-gpu}"
cuda_arch="${SIMPLE_CHAT_CUDA_ARCH:-120}"
if [[ ! "$gpu_dir" = /* || "$gpu_dir" = / || ! "$cuda_arch" =~ ^[0-9]+$ ]]; then
  echo 'Use an absolute SIMPLE_CHAT_GPU_DIR and a numeric SIMPLE_CHAT_CUDA_ARCH.' >&2
  exit 1
fi
for command in git cmake ninja nvcc nvidia-smi curl python3; do
  command -v "$command" >/dev/null || { echo "Missing dependency: $command (use a CUDA development image)." >&2; exit 1; }
done
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
mkdir -p "$gpu_dir/models"
python3 - "$gpu_dir" "$MODEL_FILE" <<'PY'
import pathlib,shutil,sys
directory=pathlib.Path(sys.argv[1])
required=4 if (directory/'models'/sys.argv[2]).is_file() else 30
if shutil.disk_usage(directory).free < required * 1024**3:
    raise SystemExit(f'At least {required} GiB free disk is required for download and build.')
PY
model_path="$gpu_dir/models/$MODEL_FILE"
# The weights arrive while llama-server builds, so the network and the compiler do not wait for each other.
# The body is not indented: the here-document inside it ends at the start of a line.
fetch_model() {
if [[ -f "$model_path" ]]; then
  echo 'Model already present; checking its content hash.'
  return 0
fi
# A completed download can survive an interrupted hash check. Do not resume
# it beyond EOF; discard an oversized partial file before downloading again.
# A parallel download writes segments at their offsets, so the file has its full size long before it is complete;
# aria2 removes its control file only when every segment has arrived.
local download_needed
download_needed="$(python3 - "$model_path.part" "$MODEL_BYTES" <<'PY'
import pathlib,sys
part=pathlib.Path(sys.argv[1]); expected=int(sys.argv[2])
if part.exists() and part.stat().st_size > expected: part.unlink()
unfinished=pathlib.Path(str(part)+'.aria2').exists()
print('no' if part.exists() and part.stat().st_size == expected and not unfinished else 'yes')
PY
)"
[[ "$download_needed" = yes ]] || return 0
local model_url="https://huggingface.co/$MODEL_REPO/resolve/$MODEL_REVISION/$MODEL_FILE"
# One connection to the hub is slow on most rented machines, so the model arrives over several by default.
# SIMPLE_CHAT_DOWNLOAD_CONNECTIONS=1 keeps the single curl download; 16 is the most aria2 opens to one server.
if [[ "$connections" != 1 ]] && ! command -v aria2c >/dev/null && command -v apt-get >/dev/null; then
  (apt-get update -qq && apt-get install -y -qq aria2) >/dev/null 2>&1 || echo 'Could not install aria2; downloading over one connection.' >&2
fi
if [[ "$connections" != 1 ]] && command -v aria2c >/dev/null; then
  aria2c --continue=true --max-connection-per-server="$connections" --split="$connections" --min-split-size=64M \
    --file-allocation=none --max-tries=5 --retry-wait=5 --console-log-level=warn --summary-interval=60 \
    --dir="$(dirname -- "$model_path")" --out="$(basename -- "$model_path").part" "$model_url"
else
  # curl resumes only a file written from its start; the segments of an unfinished parallel download are not that.
  if [[ -f "$model_path.part.aria2" ]]; then rm -f -- "$model_path.part" "$model_path.part.aria2"; fi
  curl --fail --location --silent --show-error --retry 2 --continue-at - "$model_url" -o "$model_path.part"
fi
}
connections="${SIMPLE_CHAT_DOWNLOAD_CONNECTIONS:-16}"
[[ "$connections" =~ ^([1-9]|1[0-6])$ ]] || { echo 'Use SIMPLE_CHAT_DOWNLOAD_CONNECTIONS from 1 to 16.' >&2; exit 1; }
fetch_model &
fetch_pid=$!
source_dir="$gpu_dir/llama.cpp"
if [[ ! -d "$source_dir/.git" ]]; then
  git init -q "$source_dir"
  git -C "$source_dir" remote add origin https://github.com/ggml-org/llama.cpp.git
fi
[[ "$(git -C "$source_dir" remote get-url origin)" = https://github.com/ggml-org/llama.cpp.git ]] || { echo 'Unexpected source repository.' >&2; exit 1; }
git -C "$source_dir" fetch --depth 1 origin "$LLAMA_CPP_REVISION"
git -C "$source_dir" checkout --detach "$LLAMA_CPP_REVISION"
[[ "$(git -C "$source_dir" rev-parse HEAD)" = "$LLAMA_CPP_REVISION" ]]
cmake -S "$source_dir" -B "$source_dir/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$cuda_arch" \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON
cmake --build "$source_dir/build" --target llama-server -j "${SIMPLE_CHAT_BUILD_JOBS:-4}"
wait "$fetch_pid" || { echo 'Model download failed.' >&2; exit 1; }
python3 - "$model_path" "$MODEL_SHA256" "$MODEL_BYTES" <<'PY'
import hashlib,pathlib,sys
target=pathlib.Path(sys.argv[1]); current=target if target.exists() else pathlib.Path(str(target)+'.part')
def mismatch(message):
    if current != target: current.unlink()
    raise SystemExit(message)
if current.stat().st_size != int(sys.argv[3]): mismatch('Model size mismatch; not starting. Partial file removed.')
with current.open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
if digest != sys.argv[2]: mismatch('Model SHA256 mismatch; not starting. Download again if needed.')
if current != target: current.rename(target)
print('Model SHA256 verified.')
PY
echo "Prepared. Start with: bash $task_dir/serve.sh"
