#!/usr/bin/env bash
# Live bootstrap progress: download speed and time left, build steps and time left. Read-only; exits when both are done.
# Run from the bot's computer: ssh -t simple-chat-vast bash /workspace/simple-chat/gpu/progress.sh
set -eu
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$task_dir/manifest.env"
gpu_dir="${SIMPLE_CHAT_GPU_DIR:-/workspace/simple-chat-gpu}"
exec python3 - "$gpu_dir" "$MODEL_FILE" "$MODEL_BYTES" "${1:-3}" <<'PY'
import pathlib,subprocess,sys,time
root=pathlib.Path(sys.argv[1]); model=root/'models'/sys.argv[2]; expected=int(sys.argv[3]); pause=max(1,int(sys.argv[4]))
partial=pathlib.Path(str(model)+'.part'); build=root/'llama.cpp'/'build'; server=build/'bin'/'llama-server'

def written():
    if model.exists(): return expected
    if not partial.exists(): return 0
    stat=partial.stat()
    # aria2c preallocates the whole file, so its length says nothing; count the blocks really written.
    parallel=pathlib.Path(str(partial)+'.aria2').exists()
    return min(stat.st_blocks*512,expected) if parallel else stat.st_size

def built():
    log=build/'.ninja_log'
    if not log.exists(): return 0
    with log.open(errors='replace') as lines: return len({line.rsplit('\t',2)[-2] for line in lines if '\t' in line})

def remaining():
    # A dry run prints "[n/total]" for the steps still ahead; it writes nothing.
    try:
        out=subprocess.run(['ninja','-C',str(build),'-n','llama-server'],capture_output=True,text=True,timeout=20).stdout
        last=[line for line in out.splitlines() if line.startswith('[')][-1]
        return int(last[1:last.index(']')].split('/')[1])
    except Exception: return None

def clock(seconds):
    if seconds is None or seconds!=seconds or seconds>86400: return '—'
    seconds=int(seconds); return f'{seconds//60}:{seconds%60:02d}'

def bar(share,width=24):
    filled=int(max(0,min(1,share))*width); return '█'*filled+'░'*(width-filled)

total=None; samples=[]; started=time.time()
while True:
    now=time.time(); size=written(); steps=built()
    if total is None and (build/'build.ninja').exists() and not server.exists():
        left=remaining(); total=steps+left if left is not None else None
    samples=[s for s in samples if now-s[0]<=30]+[(now,size,steps)]
    span=now-samples[0][0]
    speed=(size-samples[0][1])/span if span>0 else 0
    pace=(steps-samples[0][2])/span if span>0 else 0
    loaded=size>=expected; compiled=server.exists()
    lines=[f'Подготовка GPU · {time.strftime("%H:%M:%S")} · идёт {clock(now-started)}','']
    eta=clock((expected-size)/speed) if speed>0 and not loaded else ('готово' if loaded else '—')
    check='' if not loaded else (' · хеш проверен' if model.exists() else ' · хеш проверяется')
    lines.append(f'Веса   {bar(size/expected)} {size/1e9:5.2f} / {expected/1e9:.2f} GB · {speed*8/1e6:4.0f} Мбит/с · осталось {eta}{check}')
    if compiled: lines.append(f'Сборка {bar(1)} готово')
    elif total:
        eta=clock((total-steps)/pace) if pace>0 else '—'
        lines.append(f'Сборка {bar(steps/total)} {steps} / {total} шагов · {pace*60:3.0f} шаг/мин · осталось {eta}')
    else: lines.append(f'Сборка {bar(0)} {steps} шагов · ещё не настроена')
    sys.stdout.write('\033[H\033[J'+'\n'.join(lines)+'\n'); sys.stdout.flush()
    if compiled and model.exists(): print('\nВсё готово: можно запускать бота (npm run start:gpu).'); break
    time.sleep(pause)
PY
