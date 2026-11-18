#!/usr/bin/env python3
"""Open, show, or close the official soundtrack window for one Herdr home."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import secrets
import subprocess
import sys
import time

ASSETS = Path(__file__).resolve().parent


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def prepare(state):
    source = ASSETS / 'player.swift'
    bundle = state / 'RuneSpace Music.app' / 'Contents'
    binary = bundle / 'MacOS' / 'RuneSpaceMusic'
    stamp = state / 'station.sha256'
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if binary.is_file() and stamp.is_file() and stamp.read_text() == digest:
        return binary
    binary.parent.mkdir(parents=True, exist_ok=True)
    staged = binary.with_suffix('.build')
    build = subprocess.run(['/usr/bin/swiftc', '-swift-version', '5', '-O', str(source), '-o', str(staged)],
                           capture_output=True, text=True, timeout=100)
    if build.returncode:
        raise RuntimeError('RuneSpace Music could not compile. ' + build.stderr.strip()[-1800:])
    (bundle / 'Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': 'dev.runespace.herdr.music',
        'CFBundleName': 'RuneSpace Music',
        'CFBundleDisplayName': 'RuneSpace Music',
        'CFBundleExecutable': binary.name,
        'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1',
        'NSHighResolutionCapable': True,
    }))
    staged.replace(binary)
    stamp.write_text(digest)
    return binary


def holds_lock(path):
    with path.open('a+') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
    return False


def status(state):
    running = holds_lock(state / 'station.lock')
    return {'ok': True, 'running': running, **(read_json(state / 'station-status.json') if running else {})}


def stop_legacy_player(state):
    # The preceding mod used its own AVAudioPlayer, lock and heartbeat protocol.
    old_lock = state / 'player.lock'
    if not old_lock.is_file() or not holds_lock(old_lock):
        return
    with (state / 'control.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        old = read_json(state / 'control.json')
        if 'heartbeat' in old and 'playing' in old:
            write_json(state / 'control.json', dict(old, active=False, quit=True))


def run(command, state):
    if command == 'status':
        return status(state)
    if command == 'prepare':
        return {'ok': True, 'ready': True, 'player': str(prepare(state))}
    running = holds_lock(state / 'station.lock')
    if command == 'stop' and not running:
        return {'ok': True, 'running': False}
    process = None
    if command == 'open':
        stop_legacy_player(state)
        if not running:
            binary = prepare(state)
    request = secrets.token_hex(12)
    write_json(state / 'station-request.json', {'command': command, 'request': request})
    if command == 'open' and not running:
        with (state / 'station.log').open('ab') as log:
            process = subprocess.Popen([str(binary), str(state)], stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=log, start_new_session=True)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        result = status(state)
        if command == 'stop' and not result['running']:
            return result
        if command == 'open' and result.get('request') == request:
            return result
        if process and process.poll() is not None:
            raise RuntimeError(f'RuneSpace Music exited during launch. See {state / "station.log"}')
        time.sleep(.06)
    raise RuntimeError(f'RuneSpace Music did not respond to {command}. See {state / "station.log"}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['open', 'stop', 'status', 'prepare'])
    parser.add_argument('--app-home', type=Path)
    args = parser.parse_args()
    home = args.app_home or Path(os.environ.get('HERDR_APP_HOME', ASSETS.parents[2]))
    state = home.expanduser() / 'data/runespace-music'
    if args.app_home is None and 'RUNESPACE_MUSIC_STATE' in os.environ:
        state = Path(os.environ['RUNESPACE_MUSIC_STATE']).expanduser()
    state = state.resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'station-control.lock').open('a+') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        print(json.dumps(run(args.command, state)))


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
