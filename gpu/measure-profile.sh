#!/usr/bin/env bash
# One measurement profile on the rented machine: stop whatever serves now, start `serve.sh` under the same lock with
# exactly this profile's environment, wait for health and refuse to report success unless the running process carries
# the profile's flags.
#
# Why it exists: `ensure-server.sh` starts `serve.sh` with no environment, and the bot runs it on every reconnect
# (local/gpu-connection.ts). So during a measurement the bot can start a *default* server — one slot, isolated cache,
# no draft — which the measurer then benchmarks under the profile's name; `gpu-measure.ts --draft` only labels a
# report, it starts nothing. The marker file below is what `ensure-server.sh` respects; the lock alone leaves a gap
# while the profile server restarts.
#
# Usage on the rented machine:
#   bash gpu/measure-profile.sh --list
#   bash gpu/measure-profile.sh --print pool-3        # the profile and the measurer command; starts nothing
#   bash gpu/measure-profile.sh pool-3                # stop, start, wait for health, verify, record
#   bash gpu/measure-profile.sh --verify pool-3       # verify the running server again, mid-block
#   bash gpu/measure-profile.sh --release             # end of the session: stop the profile, give the bot its server
#
# An interrupted start leaves the marker behind, and with it the bot has no server at all. Two things undo that:
# `--release`, which stops the profile and starts the bot's own default server again, and the marker's own expiry —
# it carries the moment `ensure-server.sh` stops believing it (SIMPLE_CHAT_MEASURE_HOLD_SECONDS, two hours by
# default), and every profile start renews it. The expiry only reaches a bot that builds a new tunnel, since that is
# the only time the bot runs `ensure-server.sh`; a bot already connected gets its server back from `--release` alone.
# A bot that never starts a server again costs more than a spoiled measurement.
# `--verify PROFILE FILE` checks a saved command line instead of a running process.
set -euo pipefail
umask 077
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
gpu_dir="${SIMPLE_CHAT_GPU_DIR:-/workspace/simple-chat-gpu}"
lock="$gpu_dir/server.lock"  # the same lock ensure-server.sh uses
marker="$gpu_dir/measuring.profile"
record="$gpu_dir/profile-flags.jsonl"
port="${SIMPLE_CHAT_GPU_PORT:-8080}"
# Loading a 25 GB model from page cache takes seconds and from disk minutes; a profile that is not serving by then is
# a failure worth seeing rather than waiting out.
health_timeout="${SIMPLE_CHAT_MEASURE_HEALTH_SECONDS:-600}"
# Read beside its neighbour and not at the arithmetic that first uses it: that one runs after the profile server has
# started, so a value that is not a number would kill the script there, the trap would take the marker away, and the
# server just started would be left holding the lock with nothing to say it is there. A wait shorter than the 15 s
# appear window below is allowed on purpose and clamps it; zero is not, since it gives up before the exec it waits for.
[[ "$health_timeout" =~ ^[0-9]+$ ]] && (( health_timeout >= 1 )) \
  || { echo 'Use SIMPLE_CHAT_MEASURE_HEALTH_SECONDS in whole seconds, 1 or more.' >&2; exit 1; }
# How long the marker holds the bot back. Longer than one profile's block and shorter than a night of paid idling;
# a value that is not a number would silently become "already expired", which is the bug this guards against.
hold_seconds="${SIMPLE_CHAT_MEASURE_HOLD_SECONDS:-7200}"
[[ "$hold_seconds" =~ ^[0-9]+$ ]] && (( hold_seconds >= 60 )) \
  || { echo 'Use SIMPLE_CHAT_MEASURE_HOLD_SECONDS in whole seconds, 60 or more.' >&2; exit 1; }

# The tools this script decides with. Without pgrep a process list reads as "nothing runs": stop_server would kill
# nothing and the health wait would give up on a server that is serving. bootstrap.sh and trial-onstart.sh ask for
# their tools the same way instead of discovering the gap halfway through.
require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null \
      || { echo "measure-profile.sh needs $tool; install it (procps, util-linux, curl) first." >&2; exit 1; }
  done
}

# One request's cells and the prefill batch stay the same in every profile of a session. `decide()`
# (local/gpu-measure.ts) compares only reports whose workloads match (`sameWork`), and that fingerprint carries the
# request series and the bot's own context, never the server's `--ctx-size` or `--ubatch-size`: these two are exactly
# the mid-session change it cannot catch, so four reports would answer different questions without saying so.
# Change them between sessions, never inside one.
CONTEXT=65536
UBATCH=128
# The measurer's flags, written once here so every report of the session is comparable: they are part of that same
# fingerprint, and flags improvised per profile leave `decide()` with nothing it may compare. One cold run and one
# warm scene over the three history sizes of `battle` is 24 calls and 420 planned seconds against the 503 that
# `--minutes 12` allows (`measurementPlan`), which is what fits four profiles into one rental; each cell then holds
# one observation, and the report has to say so. The label always comes from this script.
MEASURE_FLAGS='--fixture battle --cold-runs 1 --scenes 1 --read-seconds 15 --minutes 12'
PROFILES='single pool-2 pool-3 pool-3-draft pool-3-cache-ram'

# The profiles, in one place. `pool` is the shared cache of a unified profile and must equal the bot's
# SIMPLE_CHAT_POOL_TOKENS; `cache_ram` is the host RAM snapshot cache in MiB.
#
# Every pooled profile keeps the one pool the card was measured at (docs/gpu.md, "Measured on a rented RTX 5090"), so
# the comparison between them is about slots alone. That table is also why it is not raised: it leaves 4191 MiB free
# on one slot, 2141 on two and 1717 on three at 98304 cells, so a slot costs about 424 MiB and a unified cell
# (4191-2141-424)/(98304-65536) = 0.05 MiB. Three slots at 131072 cells would therefore keep about 91 MiB by that
# table's own optimistic accounting (total minus used; `memory.free` read some 500 MiB lower still), against the
# 1024 MiB of THRESHOLDS.freeVramMiB. Recompute both numbers for another card or quantization; the floor is the
# scheduler's 78970 cells (docs/gpu.md, "The pool has a floor").
profile_env() {
  case "$1" in
    single)           slots=1 unified=false pool=0     draft=false cache_ram=0 ;;
    pool-2)           slots=2 unified=true  pool=98304 draft=false cache_ram=0 ;;
    pool-3)           slots=3 unified=true  pool=98304 draft=false cache_ram=0 ;;
    pool-3-draft)     slots=3 unified=true  pool=98304 draft=true  cache_ram=0 ;;
    pool-3-cache-ram) slots=3 unified=true  pool=98304 draft=false cache_ram=16384 ;;
    *) return 1 ;;
  esac
}

# The argv the running server must carry for this profile, one flag or flag-and-value pair per line. serve.sh builds
# the command line and stays the authority; a mismatch here means the profile did not take effect (a stale default
# server) or serve.sh changed under the profiles, and both must stop a measurement.
profile_flags() {
  local cells
  if [[ "$unified" = true ]]; then
    cells="$pool"
    printf '%s\n' '--kv-unified' "--kv-unified-per-slot $CONTEXT"
  else
    cells=$(( CONTEXT * slots ))
    printf '%s\n' '--no-kv-unified'
  fi
  printf '%s\n' "--ctx-size $cells" "--parallel $slots" "--ubatch-size $UBATCH" "--cache-ram $cache_ram" \
    '--no-cache-idle-slots' '--no-context-shift'
  if [[ "$draft" = true ]]; then printf '%s\n' '--spec-type draft-mtp'; fi
}

# The environment serve.sh reads. `env -i` on purpose: a leftover SIMPLE_CHAT_GPU_* in the operator's shell would
# otherwise decide the profile silently.
profile_command() {
  printf '%s\n' "SIMPLE_CHAT_GPU_SLOTS=$slots" "SIMPLE_CHAT_GPU_KV_UNIFIED=$unified" "SIMPLE_CHAT_GPU_POOL=$pool" \
    "SIMPLE_CHAT_GPU_DRAFT=$draft" "SIMPLE_CHAT_GPU_CACHE_RAM=$cache_ram" "SIMPLE_CHAT_GPU_CONTEXT=$CONTEXT" \
    "SIMPLE_CHAT_GPU_UBATCH=$UBATCH"
}

# argv of a process is NUL-separated; joining with the unit separator makes an exact token search a substring search.
join_argv() {
  local file="$1" argv=() token
  mapfile -d '' -t argv <"$file"
  printf '\x1f'
  for token in ${argv[@]+"${argv[@]}"}; do printf '%s\x1f' "$token"; done
}

contains_argv() { # joined argv, then the tokens that must follow each other
  local joined="$1" needle; shift
  needle="$(printf '\x1f'; printf '%s\x1f' "$@")"
  [[ "$joined" == *"$needle"* ]]
}

# Prints every difference and fails if there is one.
verify_cmdline() {
  local file="$1" joined line failures=0
  joined="$(join_argv "$file")"
  while read -r line; do
    # shellcheck disable=SC2206 # the flags hold no spaces or globs; word splitting is the parse.
    local tokens=($line)
    contains_argv "$joined" "${tokens[@]}" || { echo "Missing from the running server: $line" >&2; failures=1; }
  done < <(profile_flags)
  if [[ "$draft" = false ]] && contains_argv "$joined" '--spec-draft-model'; then
    echo 'The running server has a draft model and this profile has none.' >&2
    failures=1
  fi
  (( failures == 0 ))
}

# The logging supervisor carries the server's path in its own argv (`server-log.py … -- … llama-server …`) and it
# starts first, so the lowest match is the supervisor and not the process holding the VRAM. The server is the match
# that is not the supervisor, and only its argv is the effective command line.
server_pid() {
  local pid argv
  for pid in $(pgrep -f "$gpu_dir/llama.cpp/build/bin/llama-server" || true); do
    argv="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null)" || continue
    [[ "$argv" == *"$task_dir/server-log.py"* ]] && continue
    echo "$pid"
    return 0
  done
  return 1
}

cmdline_of() { # writes the running server's argv to the file in $1 and prints its pid, or fails
  local pid
  pid="$(server_pid)" || true
  [[ -n "$pid" ]] || { echo 'No llama-server is running.' >&2; return 1; }
  cat "/proc/$pid/cmdline" >"$1"
  echo "$pid"
}

# serve.sh execs the logging supervisor, so that supervisor is the process holding the lock. Asking whether it runs
# tells the same thing as `flock -n` and, unlike `flock -n`, does not take the lock for the moment of the question —
# a serve.sh starting in that moment would fail to take it and die.
server_running() {
  pgrep -f "$task_dir/server-log.py" >/dev/null || pgrep -f "$gpu_dir/llama.cpp/build/bin/llama-server" >/dev/null
}

stop_server() {
  pkill -f "$task_dir/server-log.py" || true
  pkill -f "$gpu_dir/llama.cpp/build/bin/llama-server" || true
  local waited=0
  while server_running; do
    (( waited < 30 )) || break
    sleep 1
    waited=$(( waited + 1 ))
  done
  if server_running; then
    pkill -KILL -f "$task_dir/server-log.py" || true
    pkill -KILL -f "$gpu_dir/llama.cpp/build/bin/llama-server" || true
    waited=0
    while server_running; do
      (( waited < 10 )) || { echo 'A server is still running and holds the lock; stop it by hand.' >&2; return 1; }
      sleep 1
      waited=$(( waited + 1 ))
    done
  fi
}

healthy() { curl -sf -m 5 -o /dev/null "http://127.0.0.1:$port/health"; }

server_appears() { # waits the given seconds for a server process to exist at all
  local waited=0 limit="$1"
  while ! server_running; do
    (( waited < limit )) || return 1
    sleep 1
    waited=$(( waited + 1 ))
  done
}

wait_for_health() {
  local waited=0 appear=15
  # The server has to appear first: a profile that never took the lock is a failure, not a slow start. Whoever allows
  # the whole start less than that allows the exec less too.
  (( appear <= health_timeout )) || appear="$health_timeout"
  server_appears "$appear" \
    || { echo "The profile server did not start; see $gpu_dir/serve-$profile.out." >&2; return 1; }
  waited=0
  until healthy; do
    if ! server_running; then echo "The profile server exited during startup; see $gpu_dir/serve-$profile.out." >&2; return 1; fi
    (( waited < health_timeout )) || { echo "No health answer in ${health_timeout}s." >&2; return 1; }
    sleep 2
    waited=$(( waited + 2 ))
  done
}

# LD_LIBRARY_PATH and CUDA_VISIBLE_DEVICES carry the CUDA runtime and the card choice of the machine, not the bot's
# configuration; everything SIMPLE_CHAT_* comes from the profile, or from nowhere when the bot's own server is started.
machine_environment() {
  if [[ -n "${LD_LIBRARY_PATH-}" ]]; then printf '%s\n' "LD_LIBRARY_PATH=$LD_LIBRARY_PATH"; fi
  if [[ -n "${CUDA_VISIBLE_DEVICES-}" ]]; then printf '%s\n' "CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES"; fi
}

start_server() {
  local environment=()
  mapfile -t environment < <(machine_environment; profile_command)
  # The log is truncated, not appended: a failed start sends the operator to this file, and yesterday's success line
  # for the same profile would answer the wrong question. `flock -n` alone says nothing when the lock is taken, so the
  # lock is held on a file descriptor and the refusal is written where the operator is sent.
  env -i PATH="$PATH" HOME="${HOME:-/root}" \
    SIMPLE_CHAT_GPU_DIR="$gpu_dir" SIMPLE_CHAT_GPU_PORT="$port" "${environment[@]}" \
    setsid bash -c 'exec 9>"$1"
      flock -n 9 || { echo "Another process holds $1; this profile did not start." >&2; exit 1; }
      exec bash "$2"' measure-profile "$lock" "$task_dir/serve.sh" \
    </dev/null >"$gpu_dir/serve-$profile.out" 2>&1 &
}

# The record of what actually ran. No credentials and no story text: a process command line and the profile's numbers.
# `verified` is written because the row is also written for a refused start: the numbers are the profile that was
# asked for, the flags are the server that answered, and the file must never claim they agreed when they did not.
write_record() {
  local pid="$1" file="$2" verified="$3"
  python3 - "$record" "$profile" "$pid" "$slots" "$unified" "$pool" "$draft" "$cache_ram" "$file" "$verified" <<'PY'
import datetime, json, pathlib, sys
path, profile, pid, slots, unified, pool, draft, cache_ram, cmdline, verified = sys.argv[1:11]
row = {'time': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
       'event': 'profile_started', 'profile': profile, 'verified': verified == 'true', 'pid': int(pid),
       'slots': int(slots),
       'unified': unified == 'true', 'pool': int(pool), 'draft': draft == 'true', 'cacheRamMiB': int(cache_ram),
       'flags': ' '.join(pathlib.Path(cmdline).read_bytes().decode('utf-8', 'replace').rstrip('\0').split('\0'))}
with open(path, 'a', encoding='utf-8') as out:
    out.write(json.dumps(row, ensure_ascii=False) + '\n')
PY
}

usage() {
  echo "Usage: bash gpu/measure-profile.sh [--print|--verify] PROFILE | --list | --release" >&2
  echo "Profiles: $PROFILES" >&2
}

mode=start
profile=
case "${1-}" in
  --list) echo "$PROFILES"; exit 0 ;;
  --release) mode=release ;;
  --print|--verify) mode="${1#--}"; profile="${2-}" ;;
  -*|'') usage; exit 1 ;;
  *) profile="$1" ;;
esac

if [[ "$mode" = release ]]; then
  # The marker goes first: this is the recovery path, and a machine without procps must still get its bot back.
  rm -f "$marker"
  require_tools pgrep pkill
  stop_server
  # Stopping is not handing back. The bot runs ensure-server.sh while it creates a tunnel and never again while that
  # tunnel lives (local/gpu-connection.ts keeps the one it has; a failing health check does not close it), so a
  # session that ends on an empty machine leaves a bot forwarding the port to nothing until it is restarted. Start
  # the bot's own default server, through the script the bot itself runs; `env -i` again, so that no leftover
  # SIMPLE_CHAT_GPU_* of this shell decides what "default" means.
  mapfile -t release_environment < <(machine_environment)
  if env -i PATH="$PATH" HOME="${HOME:-/root}" SIMPLE_CHAT_GPU_DIR="$gpu_dir" SIMPLE_CHAT_GPU_PORT="$port" \
      ${release_environment[@]+"${release_environment[@]}"} bash "$task_dir/ensure-server.sh" \
      && server_appears 15; then
    echo 'Marker removed, the profile stopped and the bot default server started; the bot owns it again.'
    exit 0
  fi
  echo "The marker is gone and no server runs; start the bot's own with: bash $task_dir/ensure-server.sh" >&2
  exit 1
fi

[[ -n "$profile" ]] || { usage; exit 1; }
slots= unified= pool= draft= cache_ram=
profile_env "$profile" || { echo "Unknown profile: $profile" >&2; usage; exit 1; }

if [[ "$mode" = print ]]; then
  echo "Profile $profile"
  profile_command | sed 's/^/  /'
  echo '  Server flags:'
  profile_flags | sed 's/^/    /'
  echo '  Measurer (run where the bot runs, through the tunnel):'
  echo "    npm run gpu:measure -- --profile $profile $MEASURE_FLAGS$([[ "$draft" = true ]] && echo ' --draft')"
  # All three lines for every profile, the values spelled out: this script runs on the rented machine and cannot see
  # .env.gpu, so the only defence against a pool's variables surviving into the next profile is to say what each one
  # must be now. The bot reads them in loadModelConfig (local/config.ts) and the measurer copies them into its report.
  echo '  Bot side (.env.gpu) must say exactly these three lines, in every profile:'
  echo "    SIMPLE_CHAT_GPU_SLOTS=$slots"
  echo "    SIMPLE_CHAT_GPU_KV_UNIFIED=$unified"
  if [[ "$unified" = true ]]; then echo "    SIMPLE_CHAT_POOL_TOKENS=$pool"; else echo "    SIMPLE_CHAT_POOL_TOKENS=$CONTEXT"; fi
  exit 0
fi

[[ "$mode" != start ]] || require_tools pgrep pkill setsid flock curl python3 tr
cmdline_file="$(mktemp)"
# Everything between writing the marker and a verified server is a state nobody may be left in: Ctrl-C, a dropped SSH
# (HUP) or a failure under `set -e` must take the marker away again, or the bot has no server and no way to know why.
# A kill -9 or an instance stop is caught by the marker's expiry instead.
holding=false
cleanup() {
  rm -f "$cmdline_file"
  [[ "$holding" = true ]] || rm -f "$marker"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

if [[ "$mode" = verify ]]; then
  holding=true  # verifying changes nothing: a marker of the session in progress stays where it is
  # A third argument is a saved command line (the NUL-separated form of /proc/PID/cmdline), which is how the check
  # itself is tested off a GPU.
  if [[ -n "${3-}" ]]; then
    pid="from $3"; cat "$3" >"$cmdline_file"
  else
    require_tools pgrep tr; pid="pid $(cmdline_of "$cmdline_file")"
  fi
  verify_cmdline "$cmdline_file" || { echo "The server ($pid) is not profile $profile." >&2; exit 1; }
  echo "The server ($pid) matches profile $profile."
  exit 0
fi

# The marker goes down first: from here until `--release` or its expiry the bot's reconnect forwards the port and
# starts nothing. `until` is the moment ensure-server.sh stops believing it; every profile start renews it.
printf '%s\nuntil=%s\n' "$profile" "$(( EPOCHSECONDS + hold_seconds ))" >"$marker"
stop_server
start_server
wait_for_health || exit 1
pid="$(cmdline_of "$cmdline_file")"
# Verify before recording: the row says which of the two it is, so the file that tells one session's measurements
# apart can never claim a refused start as the profile it asked for.
verified=true
verify_cmdline "$cmdline_file" || verified=false
write_record "$pid" "$cmdline_file" "$verified"
if [[ "$verified" = false ]]; then
  echo "Profile $profile did not take effect; measuring it would report another server's numbers." >&2
  stop_server
  exit 1
fi
holding=true
echo "Profile $profile is serving on 127.0.0.1:$port (pid $pid); flags recorded in $record."
echo "Measure with: npm run gpu:measure -- --profile $profile $MEASURE_FLAGS$([[ "$draft" = true ]] && echo ' --draft')"
