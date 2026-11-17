#!/usr/bin/env bash
# One Google Colab runtime with both lanes, text (simple-serving) and pictures (ComfyUI), on the owner's word of
# 2026-11-17 (docs/gpu.md#colab). Colab bills compute units every minute the runtime is assigned, working or idle; a
# runtime is never stopped and resumed, only released, and with it goes everything on its disk. Colab lets one
# `colab ssh` in at a time, so everything here rides on one shared SSH connection (ControlMaster): commands, copies
# and the tunnel's ports.
#
#   SIMPLE_SERVING_DIR=<simple-serving checkout> bash gpu/colab.sh up [--cpu]
#   bash gpu/colab.sh status
#   bash gpu/colab.sh down [--cpu]
#
# `up` creates the runtime, arms two guards, prepares both lanes and returns once both answer here: the text lane on
# 127.0.0.1:8080 (public) and 8081 (control), the pictures on 127.0.0.1:8188, where the bot looks for them.
#   - Inside the runtime, a thread of the notebook kernel releases it when the text gateway falls asleep (its idle
#     timer, 13 minutes, or `simple_serving.cli sleep`) or when SIMPLE_CHAT_COLAB_HOURS have passed.
#   - Here, `colab.sh keep`, which `up` leaves in the background, does the same from outside, reopens the shared
#     connection when it drops, and notes the card's highest GPU memory in its log.
# --cpu makes a CPU runtime, session `prep`, and stops after the preparation: a dry run of all but the GPU, at about
# 0.08 units an hour. The picture bootstrap fails there, as it needs a GPU.
#
# Colab differs from a Vast card in four ways this covers without changing either lane's code:
#   - Its Pythons lack ensurepip, so `python3 -m venv` fails: python3 here is a shim that runs Python 3.12, the
#     version the locks were made for, and makes venvs with `uv venv --seed`.
#   - flashinfer compiles a kernel at the engine's first load with ninja, which Colab lacks: uv puts it in.
#   - The gateway stops its own machine through Vast's API alone, and the launcher refuses to start without the
#     instance's id and key. It gets a placeholder, and console.vast.ai resolves to loopback on the runtime, so no
#     request leaves it; the kernel's thread does the stopping.
#   - The runtime has one card, so vLLM's KV cache is given a fixed size (KV_CACHE_MEMORY_MIB, which makes vLLM ignore
#     GPU_MEMORY_UTILIZATION) and the pictures take what is left. The text lane starts first.
#
# Never ssh to these aliases while no runtime is assigned: `colab ssh --proxy-mode -s NAME` creates one when NAME is
# missing, and it bills like any other. This script asks `colab sessions` before it connects.
# ~/.ssh/config must hold three aliases, each with `ControlMaster auto` and its own ControlPath for the first two:
#   simple-chat-colab        ProxyCommand colab ssh --proxy-mode -s card
#   simple-chat-colab-prep   ProxyCommand colab ssh --proxy-mode -s prep
#   simple-chat-colab-inner  ProxyCommand ssh -W 127.0.0.1:2222 simple-chat-colab, UserKnownHostsFile
#                            ~/.ssh/known_hosts-colab: the runtime's own sshd, for a tool that sets ControlPath=none
#
# Settings: SIMPLE_CHAT_COLAB_HOURS (default 2.5, at most 2.9: 10.05 units an hour against the cap of 30 a day),
# SIMPLE_CHAT_COLAB_KV_MIB (32768), SIMPLE_CHAT_COLAB_OFFLOAD_GIB (0: the KV cache's copy in RAM, unmeasured).
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
state=${XDG_STATE_HOME:-$HOME/.local/state}/simple-chat-colab
mkdir -p "$state"
hours=${SIMPLE_CHAT_COLAB_HOURS:-2.5}
kv_mib=${SIMPLE_CHAT_COLAB_KV_MIB:-32768}
offload_gib=${SIMPLE_CHAT_COLAB_OFFLOAD_GIB:-0}
card=/workspace/simple-serving-card

command=${1-}
shift || true
cpu=0
[[ ${1-} != --cpu ]] || cpu=1
if ((cpu)); then session=prep alias=simple-chat-colab-prep; else session=card alias=simple-chat-colab; fi

say() { echo "$(date +%H:%M:%S) $*"; }
# The CLI, without its notice of a newer version, which it prints on stdout before every answer.
colab() { command colab "$@" > >(grep -v --line-buffered 'new version\|colab update\|silence this\|^$' || true); }
on_card() { timeout "${ON_CARD_S:-60}" ssh -n -T "$alias" "$@"; }
feed_card() { timeout "${ON_CARD_S:-60}" ssh -T "$alias" "$@"; }
cap_s() { python3 -I -c "import sys; h=float(sys.argv[1]); assert 0 < h <= 2.9; print(int(h*3600))" "$hours"; }
alive() { colab sessions 2>/dev/null | grep -q "^\[$session\] "; }

# The shared connection, with the lanes' ports when the runtime has a GPU. It goes to the background once it is up.
connect() {
  ssh -O check "$alias" 2>/dev/null && return 0
  local forward=()
  ((cpu)) || forward=(-L 127.0.0.1:8080:127.0.0.1:8090 -L 127.0.0.1:8081:127.0.0.1:8091 -L 127.0.0.1:8188:127.0.0.1:8188)
  ssh -fN -o ControlMaster=yes -o ControlPersist=yes -o ExitOnForwardFailure=yes "${forward[@]}" "$alias"
}

# The guard inside the runtime: a thread of the notebook kernel, which survives this machine going away.
arm_kernel() {
  colab exec -s "$session" <<PY
import threading, time
from google.colab import runtime
CAP, LOG, START = $1, "$card/logs/gateway.jsonl", time.time()
def asleep():
    try:
        with open(LOG) as rows:
            return any('"event": "sleep"' in row for row in rows)
    except OSError:
        return False
def watch():
    while time.time() - START < CAP and not asleep():
        time.sleep(20)
    runtime.unassign()
threading.Thread(target=watch, daemon=True).start()
print("kernel guard armed for", CAP, "s")
PY
}

prepare() {
  say "copying simple-serving $(git -C "$SIMPLE_SERVING_DIR" rev-parse --short HEAD) and gpu/ of $(git -C "$here" rev-parse --short HEAD)"
  on_card 'mkdir -p /workspace/simple-serving /workspace/simple-chat'
  git -C "$SIMPLE_SERVING_DIR" archive HEAD | ssh -T "$alias" 'tar -x -C /workspace/simple-serving'
  git -C "$here" archive HEAD gpu | ssh -T "$alias" 'tar -x -C /workspace/simple-chat'
  # The digests of the gateway's keys, never the keys (simple-serving's README, "Keys").
  (cd "$SIMPLE_SERVING_DIR" && uv run -q python -m simple_serving.cli keys 2>/dev/null) |
    ssh -T "$alias" 'umask 077; cat > /root/keys.in; [ "$(wc -l < /root/keys.in)" -ge 2 ]'
  ON_CARD_S=300 feed_card "KV_MIB=$kv_mib OFFLOAD_GIB=$offload_gib bash -s" <<'SH'
set -euo pipefail
mkdir -p /root/colab-bin
cat > /root/colab-bin/python3 <<'PY3'
#!/bin/bash
# Python 3.12, the locks' version; Colab's Pythons lack ensurepip, so uv makes the venvs.
if [[ ${1-} == -m && ${2-} == venv ]]; then shift 2; exec uv venv -q --seed --python 3.12 "$@"; fi
exec /usr/bin/python3.12 "$@"
PY3
chmod 755 /root/colab-bin/python3
command -v ninja > /dev/null || uv pip install -q --system ninja
grep -q 'console\.vast\.ai' /etc/hosts || echo '127.0.0.1 console.vast.ai' >> /etc/hosts
(umask 077; printf 1 > /root/.simple-chat-instance-id; printf colab-no-vast > /root/.simple-chat-instance-api-key)
manifest=/workspace/simple-serving/card/manifest.env
sed -i "s/^KV_CACHE_MEMORY_MIB=.*/KV_CACHE_MEMORY_MIB=$KV_MIB/; s/^KV_OFFLOADING_GIB=.*/KV_OFFLOADING_GIB=$OFFLOAD_GIB/" "$manifest"
grep -E '^(KV_CACHE_MEMORY_MIB|KV_OFFLOADING_GIB)=' "$manifest" | tr '\n' ' '; echo
SH
}

start_text() {
  on_card "cd /workspace/simple-serving && PATH=/root/colab-bin:\$PATH CONTAINER_ID=1 CONTAINER_API_KEY=colab-no-vast \
    setsid -f nohup bash card/bootstrap.sh < /root/keys.in > /workspace/text-bootstrap.log 2>&1"
}

# The launcher again, after it gave up: the engine's first load on a new card has failed once before it held.
restart_text() {
  on_card "pkill -f '^$card/gateway/bin/python -m simple_serving.card' || true; rm -f $card/given-up $card/stop-unconfirmed
    cd /workspace/simple-serving && PATH=/root/colab-bin:\$PATH CONTAINER_ID=1 CONTAINER_API_KEY=colab-no-vast \
    setsid -f nohup bash card/onstart.sh < /dev/null > /workspace/onstart.log 2>&1"
}

start_pictures_bootstrap() {
  on_card "cd /workspace/simple-chat && PATH=/root/colab-bin:\$PATH SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_TORCH=cu130 \
    setsid -f nohup bash gpu/image-bootstrap.sh < /dev/null > /workspace/image-bootstrap.log 2>&1"
}

wait_text() {
  local deadline=$((SECONDS + 1800)) restarted=0 seen
  while ((SECONDS < deadline)); do
    sleep 15
    seen=$(on_card "test -e $card/given-up && echo given-up; grep -q '\"event\": \"ready\"' $card/logs/card.jsonl 2>/dev/null && echo ready
      pgrep -f '^bash card/bootstrap.sh' > /dev/null || test -e $card/prepared || echo bootstrap-failed" 2>/dev/null || true)
    case $seen in
      *ready*) say "text lane ready"; return 0 ;;
      *bootstrap-failed*) say "the text bootstrap ended without preparing: /workspace/text-bootstrap.log"; return 1 ;;
      *given-up*)
        ((restarted)) && { say "the text lane gave up twice"; return 1; }
        say "the text lane gave up at its first load; starting it once more"; restarted=1; restart_text ;;
    esac
  done
  say "the text lane was not ready in 30 minutes"; return 1
}

wait_pictures() {
  local deadline=$((SECONDS + 1800)) seen
  while ((SECONDS < deadline)); do
    seen=$(on_card "pgrep -f '^bash gpu/image-bootstrap.sh' > /dev/null && echo running; grep -q '^Prepared' /workspace/image-bootstrap.log && echo prepared" 2>/dev/null || true)
    case $seen in
      *running*) sleep 15; continue ;;
      *prepared*) break ;;
      *) say "the picture bootstrap failed: /workspace/image-bootstrap.log"; return 1 ;;
    esac
  done
  on_card "nohup nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -lms 2000 > /workspace/gpu-mem.log 2>&1 < /dev/null &
    PATH=/root/colab-bin:\$PATH SIMPLE_CHAT_IMAGE_TORCH=cu130 SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_GPU=0 SIMPLE_CHAT_IMAGE_TRITON=1 \
    setsid -f nohup flock -n /root/.simple-chat-comfy.lock bash /workspace/simple-chat/gpu/image-serve.sh < /dev/null > /workspace/image-serve.log 2>&1"
  deadline=$((SECONDS + 300))
  while ((SECONDS < deadline)); do
    curl -sf --max-time 5 http://127.0.0.1:8188/system_stats > /dev/null && { say "pictures ready"; return 0; }
    sleep 5
  done
  say "ComfyUI did not answer in 5 minutes: /workspace/image-serve.log"; return 1
}

# The guard here: the runtime goes when the gateway sleeps or the hours run out, the shared connection comes back
# when it drops, and the highest GPU memory seen so far goes to the log.
keep() {
  local started cap seen asleep peak
  started=$(cat "$state/started") cap=$(cap_s)
  while :; do
    sleep 30
    if (($(date +%s) - started > cap + 300)); then
      say "past the cap of $hours h; releasing the runtime"; colab stop -s "$session" || true; break
    fi
    # Checked before every connection: `colab ssh --proxy-mode -s card` makes a new runtime when there is none.
    alive || { say "the runtime is gone"; break; }
    connect 2>/dev/null || true
    if seen=$(ON_CARD_S=25 on_card "n=\$(grep -c '\"event\": \"sleep\"' $card/logs/gateway.jsonl 2>/dev/null); echo \${n:-0} \$(sort -n /workspace/gpu-mem.log 2>/dev/null | tail -1)" 2>/dev/null); then
      read -r asleep peak <<< "$seen"
      [[ -z ${peak-} ]] || echo "$peak" > "$state/peak-mib"
      if ((${asleep:-0} > 0)); then
        say "the text lane fell asleep; releasing the runtime"; sleep 60; colab stop -s "$session" || true; break
      fi
    fi
  done
  ssh -O exit "$alias" 2>/dev/null || true
  rm -f "$state/keep.pid"
}

case $command in
  up)
    [[ -n ${SIMPLE_SERVING_DIR-} && -d $SIMPLE_SERVING_DIR/card ]] || { echo 'Set SIMPLE_SERVING_DIR to a simple-serving checkout' >&2; exit 2; }
    cap=$(cap_s)
    alive && { echo "The Colab session $session is already assigned; bash gpu/colab.sh down first." >&2; exit 1; }
    if ((!cpu)); then
      for port in 8080 8081 8188; do
        if ss -ltn "sport = :$port" | grep -q LISTEN; then echo "Port $port is taken here; nothing was created." >&2; exit 1; fi
      done
    fi
    say "creating the runtime ($session)"
    if ((cpu)); then colab new -s "$session"; else colab new -s "$session" --gpu G4; fi
    date +%s > "$state/started"
    arm_kernel "$cap"
    connect
    if ((!cpu)); then
      rm -f ~/.ssh/known_hosts-colab
      ssh -o StrictHostKeyChecking=accept-new simple-chat-colab-inner true
      setsid -f nohup bash "$0" keep > "$state/keep.log" 2>&1 < /dev/null
    fi
    on_card 'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo no GPU'
    prepare
    start_text
    start_pictures_bootstrap
    if ((cpu)); then say "prepared; the bootstraps run on (see /workspace/*-bootstrap.log); bash gpu/colab.sh down --cpu ends it"; exit 0; fi
    wait_text
    wait_pictures
    colab usage | grep -i 'balance\|rate' || true
    say "both lanes answer; the runtime goes when the text lane sleeps, or after $hours h"
    ;;
  keep)
    echo $$ > "$state/keep.pid"
    keep
    ;;
  status)
    colab usage | grep -i 'balance\|rate' || true
    alive || { echo "No runtime $session is assigned."; exit 0; }
    colab status -s "$session" || true
    on_card "tail -n 3 $card/logs/card.jsonl | cut -c1-160; tail -n 1 /workspace/gpu-mem.log 2>/dev/null" || true
    [[ ! -e $state/peak-mib ]] || echo "highest GPU memory: $(cat "$state/peak-mib") MiB"
    ;;
  down)
    [[ ! -e $state/keep.pid ]] || kill "$(cat "$state/keep.pid")" 2>/dev/null || true
    colab stop -s "$session" || true
    ssh -O exit "$alias" 2>/dev/null || true
    rm -f "$state/keep.pid"
    colab usage | grep -i 'balance\|rate' || true
    ;;
  *)
    sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
