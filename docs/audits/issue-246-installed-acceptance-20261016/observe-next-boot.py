#!/usr/bin/python3
"""One-shot, read-only installed startup acceptance. Never starts/stops Bridge.

prepare DIR captures a fresh no-work preflight. observe DIR runs at next login,
rejects the same OS boot, and observes for at most the existing 150s + 300s
startup budgets. Network state is a local default-route observation, not an
Internet reachability claim. Keep DIR outside the repository, mode 0700.
"""
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import plistlib
import re
import socket
import subprocess
import sys
import time
import uuid

APP = pathlib.Path('/Applications/Codex MCP Bridge for ChatGPT.app')
RUN = pathlib.Path.home() / '.config/codex-mcp-bridge/run'
STARTUP_KEYS = ('source', 'startedAt', 'deadlineAt', 'attempts', 'stage',
                'failureCode', 'failureStage', 'nextAttemptAt', 'retrySuppressed')
WORK_KEYS = ('activeJobs', 'pendingAdmissions', 'pendingInteractions',
             'protectedMemoryOnlyThreads', 'backgroundProcesses',
             'backgroundProcessUnknownAgents', 'backgroundProcessState')


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def boot():
    identity = subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'],
                                       text=True, timeout=3).strip()
    raw = subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.boottime'],
                                  text=True, timeout=3)
    return {'id': identity, 'epoch': int(re.search(r'sec = (\d+)', raw).group(1))}


def artifact():
    info = plistlib.loads((APP / 'Contents/Info.plist').read_bytes())
    build = json.loads((APP / 'Contents/Resources/Runtime/dist/build-info.json').read_text())
    binary = APP / 'Contents/MacOS/CodexBridgeMenuBar'
    return {'version': info.get('CFBundleShortVersionString'),
            'bundleBuild': info.get('CFBundleVersion'), 'buildId': build['id'],
            'sourceHash': build['sourceHash'], 'commit': build['commit'],
            'nativeSha256': hashlib.sha256(binary.read_bytes()).hexdigest()}


def rpc(endpoint, method, params=None):
    identity = str(uuid.uuid4())
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
        stream.settimeout(2)
        stream.connect(str(RUN / endpoint))
        stream.sendall(json.dumps({'jsonrpc': '2.0', 'id': identity,
                                  'method': method, 'params': params or {}}).encode() + b'\n')
        data = b''
        while b'\n' not in data:
            chunk = stream.recv(65536)
            if not chunk or len(data) + len(chunk) > 2 * 1024 * 1024:
                raise ValueError('invalid RPC frame')
            data += chunk
    response = json.loads(data.split(b'\n', 1)[0])
    if response.get('id') != identity or 'error' in response:
        raise ValueError('RPC rejected')
    return response['result']


def selected(value, keys):
    return {key: value.get(key) for key in keys}


def snapshot():
    route = subprocess.run(['/sbin/route', '-n', 'get', 'default'],
                           capture_output=True, text=True, timeout=2)
    row = {'at': now(), 'defaultRouteAvailable': route.returncode == 0}
    try:
        health = rpc('helper.sock', 'helper.health')
        lifecycle = health.get('lifecycle') or {}
        bridge = health.get('bridge') or {}
        row.update({'helperReachable': True, 'phase': health.get('phase'),
                    'runtimePID': health.get('pid'),
                    'bridgeConnected': bridge.get('connected'),
                    'readServiceStatus': bridge.get('readServiceStatus'),
                    'tunnelConnected': (health.get('tunnel') or {}).get('connected'),
                    'work': selected(bridge, WORK_KEYS),
                    'lifecycle': selected(lifecycle, ('requestId', 'kind', 'phase', 'createdAt', 'updatedAt')),
                    'startup': selected(lifecycle.get('startup') or {}, STARTUP_KEYS)})
    except (OSError, ValueError, KeyError):
        row['helperReachable'] = False
    return row


def private_write(directory, name, value):
    target = directory / name
    temporary = directory / (name + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    os.replace(temporary, target)


def no_work(work):
    return (work.get('backgroundProcessState') == 'confirmed' and
            all(work.get(key) == 0 for key in WORK_KEYS if key != 'backgroundProcessState'))


def automatic_ready(row, boot_epoch):
    startup = row.get('startup') or {}
    lifecycle = row.get('lifecycle') or {}
    try:
        completed = datetime.datetime.fromisoformat(lifecycle['updatedAt'].replace('Z', '+00:00')).timestamp() * 1000
        within_budget = (boot_epoch * 1000 <= startup['startedAt'] <= completed <= startup['deadlineAt']
                         <= startup['startedAt'] + 300000)
        return (row.get('phase') == 'running' and row.get('runtimePID') and
                row.get('bridgeConnected') is True and row.get('tunnelConnected') is True and
                row.get('readServiceStatus') == 'ready' and lifecycle.get('kind') == 'start' and
                lifecycle.get('phase') == 'completed' and startup.get('stage') == 'ready' and
                startup.get('source') in ('helper-launch', 'application-launch') and
                1 <= startup['attempts'] <= 3 and within_budget)
    except (KeyError, TypeError, ValueError):
        return False


def prepare(directory):
    protection = rpc('bridge.sock', 'runtime.snapshot', {'inspectBackgroundProcesses': True})
    work = selected(protection, WORK_KEYS)
    if not no_work(work):
        raise SystemExit('Not armed: active or unconfirmed work. No product state changed.')
    row = snapshot()
    if not (row.get('bridgeConnected') and row.get('tunnelConnected')):
        raise SystemExit('Not armed: baseline is not connected.')
    manifest = {'kind': 'issue-246-installed-next-boot', 'preparedAt': now(),
                'boot': boot(), 'artifact': artifact(), 'preflight': work,
                'observationLimitSeconds': 450}
    private_write(directory, 'manifest.json', manifest)
    private_write(directory, 'preflight.json', row)
    print('Armed for the next OS boot; no server, login, or network settings changed.')


def observe(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    assert manifest['kind'] == 'issue-246-installed-next-boot'
    current_boot = boot()
    if current_boot['id'] == manifest['boot']['id']:
        private_write(directory, 'same-boot-rejected.json', {'at': now(), 'accepted': False})
        return
    if (directory / 'result.json').exists():
        return  # One boot observation only; no repeated monitoring.
    identity_matches = artifact() == manifest['artifact']
    prepared_epoch = datetime.datetime.fromisoformat(manifest['preparedAt']).timestamp()
    fresh_preflight = 0 <= current_boot['epoch'] - prepared_epoch <= 600
    offline_seen = False
    online_after_offline = False
    ready = False
    end = time.monotonic() + 450
    with open(directory / 'observations.jsonl', 'x', encoding='utf8') as stream:
        os.chmod(stream.name, 0o600)
        while time.monotonic() < end:
            row = snapshot()
            offline_seen |= not row['defaultRouteAvailable']
            online_after_offline |= offline_seen and row['defaultRouteAvailable']
            ready = bool(automatic_ready(row, current_boot['epoch']))
            stream.write(json.dumps(row) + '\n')
            stream.flush()
            if ready or (row.get('lifecycle', {}).get('phase') in ('failed', 'cancelled')):
                break
            time.sleep(1)
    private_write(directory, 'result.json', {
        'observedAt': now(), 'rebootObserved': True, 'artifactMatches': identity_matches,
        'noWorkPreflight': no_work(manifest['preflight']), 'freshPreflight': fresh_preflight,
        'automaticReadyWithinBudget': ready,
        'defaultRouteAbsentThenRestored': online_after_offline,
        'technicalChecksPassed': bool(identity_matches and fresh_preflight and ready and online_after_offline and no_work(manifest['preflight'])),
        'userConfirmationRequired': 'No menu/manual start; network deliberately unavailable at login then restored.',
        'boot': current_boot})


def main():
    os.umask(0o077)
    command, raw_directory = sys.argv[1:]
    directory = pathlib.Path(raw_directory).expanduser().absolute()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    assert not directory.is_symlink() and directory.stat().st_uid == os.getuid()
    assert directory.stat().st_mode & 0o077 == 0, 'Evidence directory must be private.'
    with open(directory / 'observer.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if command == 'prepare':
            prepare(directory)
        elif command == 'observe':
            observe(directory)
        else:
            raise SystemExit('Usage: observe-next-boot.py prepare|observe PRIVATE_DIRECTORY')


if __name__ == '__main__':
    main()
