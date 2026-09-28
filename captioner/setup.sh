#!/usr/bin/env bash
# The pose captioner beside the bot (captioner/caption.py, docs/setup.md#pose-sets): a CPU-only Python environment in
# captioner/.venv and openjev 0.8B's weights in models/pose-captioner, from openjev's pinned revision, every file checked
# against its SHA256 before it is kept. Run once from anywhere: bash captioner/setup.sh. It needs uv, Python 3.14 and
# about 3.5 GB of disk: 1.7 GB of weights and the environment. Nothing of it is needed unless SIMPLE_CHAT_POSE_SET_USERS
# names somebody; `rm -rf captioner/.venv models/pose-captioner` removes it all.
set -euo pipefail
cd "$(dirname "$0")/.."
revision=a298f274886c4676c42f1a4262401b6aa9653e6d
folder=qwen3.5-0.8b-nli-v2s-long
target=models/pose-captioner
declare -A files=(
  [config.json]=3b914561e53dad38981a498af0b0bf430300be9d3e5fa3cd7b10c2049c073e52
  [preprocessor_config.json]=27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516
  [tokenizer_config.json]=289d88d849f89fcf0f9c145773122f6718095cd4aee05435afbd0293569c7085
  [chat_template.jinja]=273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80
  [tokenizer.json]=d73c2c5f7aa0ed522c8d96ef3524739eb61e3c78e74839a2ce4a1c56ea340a20
  [model.safetensors]=cf6d62a341c0c804f9a926eec71aefc9859adb28978736e757b49bce35d9b8f8
)

if [[ ! -f captioner/.venv/pose-captioner-ready ]]; then
  rm -rf captioner/.venv
  uv venv --python 3.14 captioner/.venv
  uv pip install --python captioner/.venv/bin/python 'torch==2.14.0' 'torchvision==0.29.0' --index-url https://download.pytorch.org/whl/cpu
  uv pip install --python captioner/.venv/bin/python 'transformers==5.17.0' 'tokenizers==0.23.2' 'safetensors==0.8.0' 'numpy==2.5.2' 'pillow==12.3.0' 'huggingface-hub==1.33.0'
  touch captioner/.venv/pose-captioner-ready
fi

mkdir -p "$target"
for file in "${!files[@]}"; do
  if [[ -f "$target/$file" ]] && echo "${files[$file]}  $target/$file" | sha256sum -c --status -; then echo "have $file"; continue; fi
  curl -fL --retry 5 --retry-delay 10 -C - -sS -o "$target/$file.part" "https://huggingface.co/AlexWortega/openjev/resolve/$revision/$folder/$file"
  if ! echo "${files[$file]}  $target/$file.part" | sha256sum -c --status -; then
    rm -f "$target/$file.part"; echo "SHA256 mismatch for $file; the file is removed." >&2; exit 1
  fi
  mv "$target/$file.part" "$target/$file"
  echo "verified $file"
done
captioner/.venv/bin/python -c 'import torch, transformers, PIL; print("torch", torch.__version__, "transformers", transformers.__version__, "pillow", PIL.__version__)'
