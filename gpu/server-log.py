#!/usr/bin/env python3
"""Run llama-server and retain technical error categories, never raw output."""
import datetime
import json
import os
import re
from pathlib import Path
import signal
import subprocess
import sys


# At start the server prints its own memory layout: the size of every cache, how many cells and layers it holds, and
# what each buffer costs. Those numbers settle the arguments this project keeps having about where the video memory
# goes -- twice a rented card was measured by subtraction because they were thrown away with everything else. Only
# the numbers are kept, never the line: whole MiB and counts, plus a cache type from a fixed set. A line that does not
# match one of these exactly is not a measurement and falls through to `category` as before.
# Searched, not anchored: the server is started with --log-prefix --log-timestamps, so every line begins with a
# timestamp and a level, and an anchored pattern matched nothing at all on the first run that needed it. Searching is
# safe here because every group is an integer or a word from MEASUREMENT_WORDS; nothing is taken off the line as-is.
MEASUREMENTS = (
    re.compile(r'\bllama_kv_cache[a-z_:]*:\s+size\s*=\s*(?P<sizeMiB>\d{1,7})\.\d+ MiB'
               r'\s*\(\s*(?P<cells>\d{1,8}) cells,\s*(?P<layers>\d{1,4}) layers'
               r'(?:,\s*(?P<seqs>\d{1,4})/\d{1,4} seqs)?\)'
               r'(?:.*?\bK \((?P<keyType>[a-z0-9_]{1,8})\):\s*(?P<keyMiB>\d{1,7})\.\d+ MiB)?'
               r'(?:.*?\bV \((?P<valueType>[a-z0-9_]{1,8})\):\s*(?P<valueMiB>\d{1,7})\.\d+ MiB)?'),
    re.compile(r'\b[a-z_]{1,32}:\s+(?P<device>[A-Za-z0-9_]{1,16})\s+(?P<kind>compute|model|KV|KV self|output)'
               r'\s+buffer size\s*=\s*(?P<sizeMiB>\d{1,7})\.\d+ MiB'),
)
# The only words any of the patterns above may hand over verbatim; anything else is dropped rather than written.
MEASUREMENT_WORDS = {'f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'iq4_nl',
                     'compute', 'model', 'KV', 'KV self', 'output',
                     'CPU', 'CUDA0', 'CUDA1', 'CUDA2', 'CUDA3', 'CUDA_Host', 'Metal', 'Vulkan0', 'SYCL0'}


def measurement(line):
    """Integers and fixed words from a memory line, or None. Never returns anything read off the line verbatim
    that is not in MEASUREMENT_WORDS."""
    for pattern in MEASUREMENTS:
        found = pattern.search(line)
        if not found:
            continue
        fields = {}
        for name, value in found.groupdict().items():
            if value is None:
                continue
            if value.isdigit():
                fields[name] = int(value)
            elif value in MEASUREMENT_WORDS:
                fields[name] = value
            else:
                return None
        return fields or None
    return None


def category(line):
    value = line.lower()
    if any(s in value for s in ('out of memory', 'cudaerrormemoryallocation', 'cublas_status_alloc_failed')):
        return 'out_of_memory'
    if 'cuda' in value or 'cublas' in value:
        return 'cuda_error'
    if 'std::bad_alloc' in value or 'cannot allocate memory' in value:
        return 'host_allocation_failed'
    if 'assert' in value or 'abort' in value:
        return 'assertion_failed'
    if 'grammar' in value:
        return 'grammar_error'
    if 'kv cache' in value or 'kv-cache' in value:
        return 'kv_cache_error'
    if 'context' in value and any(s in value for s in ('exceed', 'too large', 'too long', 'limit')):
        return 'context_limit'
    if 'decode' in value and any(s in value for s in ('fail', 'error')):
        return 'decode_failed'
    if 'address already in use' in value or 'failed to bind' in value:
        return 'bind_failed'
    return 'unclassified_output'


class Log:
    def __init__(self, path, max_bytes=1024 * 1024):
        self.path = Path(path)
        self.max_bytes = max_bytes
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    def event(self, event, **fields):
        if self.path.exists() and self.path.stat().st_size >= self.max_bytes:
            older = Path(str(self.path) + '.1')
            if older.exists(): older.replace(str(self.path) + '.2')
            self.path.replace(older)
        data = json.dumps({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'event': event, **fields}) + '\n'
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, data.encode())
        finally:
            os.close(fd)


def run(log, command):
    child = None
    previous = {}
    try:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        def forward(number, _frame):
            if child.poll() is None:
                log.event('server_stop_requested', signal=signal.Signals(number).name)
                os.killpg(child.pid, number)
        for number in (signal.SIGTERM, signal.SIGINT):
            previous[number] = signal.signal(number, forward)
        log.event('server_started', pid=child.pid)
        # Chunk limits prevent an accidentally logged prompt from growing RAM.
        # Even error-level messages may interpolate request content: no raw
        # line, filename, quotation, traceback or arbitrary code is persisted.
        while chunk := child.stdout.readline(8192):
            if not chunk.strip(): continue
            line = chunk.decode('utf-8', errors='replace')
            sizes = measurement(line)
            if sizes is not None:
                log.event('server_memory', **sizes)
            else:
                log.event('server_diagnostic', category=category(line))
        code = child.wait()
        log.event('server_exit', **({'exitCode': code} if code >= 0 else {'signal': signal.Signals(-code).name}))
        return code if code >= 0 else 128 - code
    except Exception:
        log.event('server_supervisor_failed')
        return 1
    finally:
        for number, handler in previous.items(): signal.signal(number, handler)
        if child is not None:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            child.stdout.close()


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) < 4 or sys.argv[2] != '--': raise SystemExit(2)
    raise SystemExit(run(Log(sys.argv[1]), sys.argv[3:]))
