#!/usr/bin/env python3
"""Read-only snapshot of the model server's machine: one JSON line of technical fields.

local/gpu-diagnose.ts pipes this file to `python3 -` over a separate SSH session, so it needs no deployment.
With --every it keeps printing one line per interval through that session until --limit seconds have passed.
With --parts it reports only the parts named, for a watcher that reads one of them often.
It reads no request bodies, server output, environment or process arguments. Every string it prints comes from
a fixed list or matches a strict pattern; everything else is a number.
"""
import argparse
import concurrent.futures
import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

NAME = re.compile(r'^[a-z_]{1,40}$')
CLASS = re.compile(r'^[A-Za-z]{1,40}$')
MODEL = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$')
AT = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$')
SIGNAL = re.compile(r'^SIG[A-Z0-9+-]{2,10}$')
STARTUPS = re.compile(r'(\d+) of (\d+)-(\d+) startups')
TCP_STATES = {'01': 'established', '03': 'synRecv', '08': 'closeWait', '0A': 'listen'}
# Loopback only: a proxy configured in the environment is never used.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def integer(value, limit=2 ** 31):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < limit else None


def probe(port, path):
    """Status and duration of one loopback request. A failure keeps only the exception class."""
    started = time.monotonic()
    result, body = {}, None
    try:
        with OPENER.open(f'http://127.0.0.1:{port}{path}', timeout=5) as response:
            result['httpStatus'] = response.status
            body = response.read(2_000_000)
    except urllib.error.HTTPError as error:
        result['httpStatus'] = error.code
    except Exception as error:
        reason = getattr(error, 'reason', None)
        cause = reason if isinstance(reason, Exception) else error
        name = 'timeout' if isinstance(cause, TimeoutError) else type(cause).__name__
        result['failure'] = name if CLASS.match(name) else 'other'
    result['seconds'] = round(time.monotonic() - started, 3)
    return result, body


def http(port):
    paths = {'health': '/health', 'models': '/v1/models', 'props': '/props'}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(paths)) as pool:
        pending = {key: pool.submit(probe, port, path) for key, path in paths.items()}
        results = {key: future.result() for key, future in pending.items()}
    report = {key: result for key, (result, _body) in results.items()}
    for key, (_result, body) in results.items():
        try:
            data = json.loads(body) if body else None
        except ValueError:
            continue
        if not isinstance(data, dict):
            continue
        if key == 'models':
            models = data.get('data')
            first = models[0].get('id') if isinstance(models, list) and models and isinstance(models[0], dict) else None
            if isinstance(first, str) and MODEL.match(first):
                report[key]['modelId'] = first
        if key == 'props':
            settings = data.get('default_generation_settings')
            context = integer(settings.get('n_ctx')) if isinstance(settings, dict) else None
            if context is not None:
                report[key]['contextTokens'] = context
            if integer(data.get('total_slots')) is not None:
                report[key]['slots'] = data['total_slots']
    return report


def sockets(port):
    """TCP sockets whose local port is the server's, by state: held or half-open connections show up here."""
    counts = {name: 0 for name in TCP_STATES.values()}
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            lines = Path(table).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            try:
                local = int(fields[1].rsplit(':', 1)[1], 16)
            except (IndexError, ValueError):
                continue
            state = TCP_STATES.get(fields[3]) if len(fields) > 3 else None
            if local == port and state:
                counts[state] += 1
    return counts


def ancestors():
    """This script's own chain of parents: the SSH session that runs it is not counted."""
    chain, pid = set(), os.getpid()
    while pid > 1 and pid not in chain:
        chain.add(pid)
        try:
            pid = int(Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return chain


def processes():
    ticks = os.sysconf('SC_CLK_TCK')
    uptime = float(Path('/proc/uptime').read_text().split()[0])
    own = ancestors()
    servers = []
    ssh = {'sessions': 0, 'unauthenticated': 0}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            name = (entry / 'comm').read_text().strip()
            if name == 'llama-server':
                stat = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
                server = {'pid': int(entry.name), 'ageSeconds': max(0, round(uptime - int(stat[19]) / ticks))}
                if re.fullmatch(r'[A-Za-z]', stat[0]):
                    server['state'] = stat[0]
                servers.append(server)
            elif name in ('sshd', 'sshd-session', 'sshd-auth'):
                # Only sshd's own phase markers are inspected; the title is never printed.
                title = (entry / 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf-8', 'replace')
                startups = STARTUPS.search(title) if '[listener]' in title else None
                if startups:
                    # sshd's own count of connections that have not authenticated yet, and its MaxStartups settings:
                    # from `dropFrom` it refuses some new connections at random, at `dropAllAt` all of them.
                    ssh['startups'], ssh['dropFrom'], ssh['dropAllAt'] = (int(value) for value in startups.groups())
                elif any(mark in title for mark in ('[accepted]', '[net]', '[preauth]')):
                    ssh['unauthenticated'] += 1
                elif '@' in title and int(entry.name) not in own:
                    ssh['sessions'] += 1
        except (OSError, ValueError, IndexError):
            continue
    return {'llamaServer': sorted(servers, key=lambda server: server['pid']), 'sshd': ssh}


def compute_pids():
    """Which processes hold memory on which card, keyed by the card's UUID. The UUID identifies a rented machine's
    hardware and stays here; only the driver's index and the pids leave."""
    result = subprocess.run(['nvidia-smi', '--query-compute-apps=gpu_uuid,pid', '--format=csv,noheader,nounits'],
                            capture_output=True, text=True, timeout=5)
    by_uuid = {}
    for line in result.stdout.strip().splitlines()[:256]:
        values = [value.strip() for value in line.split(',')]
        if len(values) == 2 and values[1].isdigit():
            by_uuid.setdefault(values[0], []).append(int(values[1]))
    return by_uuid


def gpus():
    """One entry per GPU, carrying the driver's own index and the pids computing on it: on a two-card box one card
    runs the model server and the other something else, and a reading without an index cannot say which, nor which
    of them llama-server sits on. A value the driver does not report, printed as [N/A], is left out."""
    # memory.free is asked for rather than derived: in this output the driver's own reserve is a third number beside
    # used and total, so total minus used overstates what is left by that reserve. On the measured 5090 the reserve is
    # 498 MiB, and the headroom threshold is 1024 - large enough to turn a fail into a pass.
    keys = ('index', 'memoryUsedMiB', 'memoryFreeMiB', 'memoryTotalMiB', 'utilizationPercent', 'temperatureC')
    result = subprocess.run(['nvidia-smi', '--query-gpu=uuid,index,memory.used,memory.free,memory.total,utilization.gpu,temperature.gpu',
                             '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=5)
    # A driver that cannot list the compute processes (an old one, or a container without the privilege) still
    # reports memory; the cards then carry no pids and the card in use has to be named by hand.
    try:
        by_uuid = compute_pids()
    except Exception:
        by_uuid = {}
    cards = []
    for line in result.stdout.strip().splitlines()[:16]:
        uuid, *values = [value.strip() for value in line.split(',')]
        card = {key: int(value) for key, value in zip(keys, values) if value.isdigit()}
        card['pids'] = sorted(by_uuid.get(uuid, []))
        cards.append(card)
    return cards


def machine():
    """Numbers of the whole rented machine; inside a container they include other tenants."""
    report = {}
    try:
        report['load1'] = float(Path('/proc/loadavg').read_text().split()[0])
    except (OSError, ValueError, IndexError):
        pass
    try:
        report['cpus'] = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        pass
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.startswith('MemAvailable:'):
                report['memoryAvailableMiB'] = int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        pass
    return report


def numbers(path):
    """`key value` lines of a kernel statistics file."""
    try:
        rows = [line.split() for line in Path(path).read_text().splitlines()]
    except OSError:
        return {}
    return {row[0]: int(row[1]) for row in rows if len(row) == 2 and row[1].isdigit()}


def first(*paths):
    for path in paths:
        try:
            return Path(path).read_text()
        except OSError:
            continue
    return ''


def container():
    """This container's own limits. A throttled or memory-bound container stalls new processes, and a new SSH session
    is one. With cgroup v2 the files are looked up under this process's own group first: a container that shares the
    host's cgroup namespace sees the whole machine at the top of /sys/fs/cgroup. With v1 the mount is the group."""
    report = {}
    own = ''
    for line in first('/proc/self/cgroup').splitlines():
        if line.startswith('0::/') and '..' not in line:
            own = line[3:].rstrip('/')
    roots = [f'/sys/fs/cgroup{own}', '/sys/fs/cgroup'] if own else ['/sys/fs/cgroup']
    cpu = {}
    for path in [f'{root}/cpu.stat' for root in roots] + ['/sys/fs/cgroup/cpu/cpu.stat', '/sys/fs/cgroup/cpu,cpuacct/cpu.stat']:
        cpu = numbers(path)
        if 'nr_throttled' in cpu:
            break
    if 'nr_throttled' in cpu:
        report['throttledPeriods'] = cpu['nr_throttled']
    if 'throttled_usec' in cpu:
        report['throttledSeconds'] = cpu['throttled_usec'] // 10 ** 6
    elif 'throttled_time' in cpu:
        report['throttledSeconds'] = cpu['throttled_time'] // 10 ** 9
    for key, v2, v1 in (('memoryMiB', 'memory.current', 'memory/memory.usage_in_bytes'), ('memoryLimitMiB', 'memory.max', 'memory/memory.limit_in_bytes')):
        value = first(*[f'{root}/{v2}' for root in roots], f'/sys/fs/cgroup/{v1}').strip()
        # No limit is the word "max" in v2 and a number of exabytes in v1.
        if value.isdigit() and int(value) < 2 ** 50:
            report[key] = int(value) // 2 ** 20
    # Percent of the last 10 seconds in which some task waited for the resource. The top group has no such files;
    # /proc/pressure describes the whole machine, other tenants included, and the scope says so.
    pressure = {}
    for name in ('cpu', 'io', 'memory'):
        for scope, path in [('container', f'{root}/{name}.pressure') for root in roots] + [('machine', f'/proc/pressure/{name}')]:
            match = re.search(r'^some avg10=(\d{1,3}(?:\.\d{1,2})?)', first(path), re.M)
            if match:
                pressure[name] = float(match.group(1))
                pressure['scope'] = 'machine' if 'machine' in (scope, pressure.get('scope')) else 'container'
                break
    if pressure:
        report['pressure'] = pressure
    return report


def clean(row):
    """The fields server-log.py writes, each checked again: this file's rows leave the instance."""
    event = {}
    if isinstance(row.get('at'), str) and AT.match(row['at']):
        event['at'] = row['at']
    for key in ('event', 'category'):
        if isinstance(row.get(key), str) and NAME.match(row[key]):
            event[key] = row[key]
    for key in ('pid', 'exitCode'):
        if integer(row.get(key)) is not None:
            event[key] = row[key]
    if isinstance(row.get('signal'), str) and SIGNAL.match(row['signal']):
        event['signal'] = row['signal']
    return event if 'event' in event else None


def server_events(directory, limit):
    base = directory / 'server-events.jsonl'
    report = {'rows': []}
    for path in (Path(f'{base}.2'), Path(f'{base}.1'), base):
        try:
            if path == base:
                report['mode'] = oct(path.stat().st_mode & 0o777)
            text = path.read_text(errors='replace')
        except OSError:
            continue
        for line in text.splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            event = clean(row) if isinstance(row, dict) else None
            if event:
                report['rows'].append(event)
    report['total'] = len(report['rows'])
    if limit is not None:
        report['rows'] = report['rows'][-limit:] if limit else []
    return report


def events_limit(value):
    if value == 'all':
        return None
    if not re.fullmatch(r'\d{1,4}', value):
        raise argparse.ArgumentTypeError('expected a number up to 9999 or "all"')
    return int(value)


PARTS = ('sockets', 'processes', 'gpus', 'machine', 'container', 'http', 'serverEvents')


def part_names(value):
    names = [name for name in value.split(',') if name]
    if not names or any(name not in PARTS for name in names):
        raise argparse.ArgumentTypeError('expected parts out of ' + ','.join(PARTS))
    return set(names)


def snapshot(options):
    report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    # Sockets and processes are counted before this script opens its own connections. A part that fails is left out
    # and named, so the rest of the snapshot still arrives. --parts keeps only the parts asked for: a watcher reading
    # the cards every couple of seconds has no use for a walk of /proc, three requests at the server it is watching
    # and a re-read of the whole server log, thirty times a minute.
    for key, part in (('sockets', lambda: sockets(options.port)), ('processes', processes), ('gpus', gpus), ('machine', machine),
                      ('container', container), ('http', lambda: http(options.port)),
                      ('serverEvents', lambda: server_events(Path(options.dir), options.events))):
        if options.parts and key not in options.parts:
            continue
        try:
            report[key] = part()
        except Exception:
            report.setdefault('failed', []).append(key)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', default='/workspace/simple-chat-gpu')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--events', type=events_limit, default=25)
    parser.add_argument('--parts', type=part_names, default=None)
    parser.add_argument('--every', type=int, default=0)
    parser.add_argument('--limit', type=int, default=3600)
    options = parser.parse_args()
    if not (0 < options.port < 65536 and 0 <= options.every <= 3600 and 0 < options.limit <= 86400):
        raise SystemExit(2)
    # A watcher whose session is lost without a close would otherwise stay on the instance; the limit ends it.
    deadline = time.monotonic() + options.limit
    while True:
        started = time.monotonic()
        try:
            print(json.dumps(snapshot(options), separators=(',', ':')), flush=True)
        except BrokenPipeError:
            # The SSH session is gone. Without a new stdout Python reports the same error once more on exit.
            os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
            break
        if not options.every or started + options.every > deadline:
            break
        # A fixed cadence: the time a snapshot took is not added to the interval.
        time.sleep(max(0.0, started + options.every - time.monotonic()))
