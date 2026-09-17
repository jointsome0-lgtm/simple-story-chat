#!/usr/bin/env bash
# Read-only progress display; no environment, process arguments or story logs.
set -eu
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$task_dir/manifest.env"
gpu_dir="${SIMPLE_CHAT_GPU_DIR:-/workspace/simple-chat-gpu}"
date -u '+%Y-%m-%d %H:%M:%S UTC'
nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv
if [[ -f "$gpu_dir/llama.cpp/build/.ninja_log" ]]; then
  printf 'Completed build actions: '
  awk 'NR>1 {n++} END {print n+0}' "$gpu_dir/llama.cpp/build/.ninja_log"
fi
printf 'Active CUDA compilers: '
pgrep -cx nvcc || true
if [[ -x "$gpu_dir/llama.cpp/build/bin/llama-server" ]]; then
  printf 'llama-server: built\n'
fi
python3 - "$gpu_dir/models/$MODEL_FILE" "$MODEL_BYTES" <<'PY'
import pathlib,sys
model=pathlib.Path(sys.argv[1]); partial=pathlib.Path(str(model)+'.part')
file=model if model.exists() else partial
expected=int(sys.argv[2])
stat=file.stat() if file.exists() else None
parallel=pathlib.Path(str(partial)+'.aria2').exists()
size=min(stat.st_blocks*512,expected) if stat and parallel else (stat.st_size if stat else 0)
prefix='Model data written (approx.)' if parallel else 'Model download'
print(f'{prefix}: {size/1e9:.2f} / {expected/1e9:.2f} GB ({size/expected:.1%})')
print('Model hash: verified' if model.exists() else 'Model hash: pending')
for quant in ('Q4_K_M','Q5_K_M','Q6_K'):
    candidate=model.parent/f'gemma-4-31B-it-uncensored-heretic-{quant}.gguf'
    if candidate==model: continue
    part=pathlib.Path(str(candidate)+'.part')
    if not candidate.exists() and not part.exists(): continue
    sizes={'Q4_K_M':18687063168,'Q5_K_M':21845570688,'Q6_K':25201484928}
    metadata=(candidate if candidate.exists() else part).stat()
    written=min(metadata.st_blocks*512,sizes[quant]) if pathlib.Path(str(part)+'.aria2').exists() else metadata.st_size
    status='verified' if candidate.exists() else 'downloading / hash pending'
    print(f'{quant}: {written/1e9:.2f} / {sizes[quant]/1e9:.2f} GB ({written/sizes[quant]:.1%}), {status}')
PY
if [[ -f /root/.simple-chat-trial-deadline ]]; then
  deadline="$(cat /root/.simple-chat-trial-deadline)"
  printf 'Remote cleanup deadline: '
  date -u -d "@$deadline" '+%Y-%m-%d %H:%M:%S UTC'
fi
