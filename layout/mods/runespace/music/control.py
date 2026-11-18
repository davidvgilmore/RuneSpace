#!/usr/bin/env python3
"""Control the guild’s background soundtrack for one Herdr home."""

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
        'CFBundleVersion': '2',
        'LSUIElement': True,
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
    if running:
        return {'ok': True, **read_json(state / 'station-status.json'), 'running': True}
    return {'ok': True, 'version': 2, 'running': False, 'phase': 'stopped', 'playing': False,
            'track': 1, 'title': '', 'elapsed': 0, 'duration': 0, 'tracks': []}


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


def dispatch(command, state, track=None, binary=None):
    request = secrets.token_hex(12)
    message = {'command': command, 'request': request}
    if track is not None:
        message['track'] = track
    write_json(state / 'station-request.json', message)
    process = None
    if binary is not None:
        with (state / 'station.log').open('ab') as log:
            process = subprocess.Popen([str(binary), str(state)], stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=log, start_new_session=True)
    # A first selection may wait for the official widget's network timeout.
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        result = status(state)
        if command == 'stop' and not result['running']:
            return result
        if command != 'stop' and result.get('request') == request:
            return result
        if process and process.poll() is not None:
            raise RuntimeError(f'RuneSpace Music exited during launch. See {state / "station.log"}')
        time.sleep(.08)
    raise RuntimeError(f'RuneSpace Music did not respond to {command}. See {state / "station.log"}')


def run(command, state, track):
    current = status(state)
    if command == 'status':
        return current
    if command == 'prepare':
        return {'ok': True, 'ready': True, 'player': str(prepare(state))}
    if command == 'stop':
        return dispatch('stop', state) if current['running'] else current
    # Earlier versions own the same lock but treat every unknown command as a
    # request to raise their window. Close that instance using its own protocol.
    if current['running'] and current.get('version') != 2:
        current = dispatch('stop', state)
    if not current['running'] and command == 'pause':
        return current
    binary = None
    if not current['running']:
        stop_legacy_player(state)
        binary = prepare(state)
    return dispatch(command, state, track, binary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['open', 'play', 'pause', 'next', 'previous', 'stop', 'status', 'prepare'])
    parser.add_argument('--track', type=int, metavar='1-43')
    parser.add_argument('--app-home', type=Path)
    args = parser.parse_args()
    if args.track is not None and (args.command != 'play' or not 1 <= args.track <= 43):
        parser.error('--track must select a number from 1 to 43 with the play command')
    home = args.app_home or Path(os.environ.get('HERDR_APP_HOME', ASSETS.parents[2]))
    state = home.expanduser() / 'data/runespace-music'
    if args.app_home is None and 'RUNESPACE_MUSIC_STATE' in os.environ:
        state = Path(os.environ['RUNESPACE_MUSIC_STATE']).expanduser()
    state = state.resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'station-control.lock').open('a+') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        print(json.dumps(run(args.command, state, args.track)))


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
