#!/usr/bin/env python3
"""Control the one embedded guild call associated with a Herdr app home."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from launch import desktop_pid, read_json


def atomic(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        out.write(data)
    os.replace(out.name, path)


def invite(home):
    config = read_json(home / 'data/runespace-team.json')
    if not config:
        return None
    url = urlsplit(str(config.get('url', '')))
    local = url.hostname in ('localhost', '127.0.0.1', '::1')
    params = parse_qs(url.fragment)
    if not (url.hostname and (url.scheme == 'https' or (local and url.scheme == 'http'))
            and not url.username and not url.password and params.get('invite', [''])[0]):
        raise ValueError('The guild invitation is incomplete. Reconfigure the team room.')
    return urlunsplit((url.scheme, url.netloc, '/', '', urlencode({'invite': params['invite'][0]})))


def running(folder):
    with (folder / 'instance.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False


def build(folder):
    src = Path(__file__).resolve().with_name('social.swift')
    name = 'RuneSpace Calls'
    contents = folder / (name + '.app') / 'Contents'
    binary = contents / 'MacOS' / 'RuneSpaceCalls'
    info = plistlib.dumps({
        'CFBundleIdentifier': 'dev.runespace.guild.calls', 'CFBundleExecutable': binary.name,
        'CFBundleName': name, 'CFBundleDisplayName': name, 'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0', 'LSUIElement': True,
        'NSCameraUsageDescription': 'Share your camera with nearby teammates when you turn it on in RuneSpace.',
        'NSMicrophoneUsageDescription': 'Share your voice with nearby teammates when you turn on the guild microphone.',
        'NSLocalNetworkUsageDescription': 'Join the private guild configured in Herdr.',
    })
    key = hashlib.sha256(info + src.read_bytes()).hexdigest()
    stamp = contents / 'Resources/source-hash'
    if binary.is_file() and stamp.is_file() and stamp.read_text() == key:
        return binary
    with tempfile.TemporaryDirectory(dir=folder) as temp:
        staged = Path(temp) / (name + '.app')
        exe = staged / 'Contents/MacOS' / binary.name
        exe.parent.mkdir(parents=True)
        subprocess.run(['/usr/bin/xcrun', 'swiftc', '-O', '-swift-version', '5', str(src), '-o', str(exe)],
                       check=True, timeout=120)
        (staged / 'Contents/Info.plist').write_bytes(info)
        (staged / 'Contents/Resources').mkdir()
        (staged / 'Contents/Resources/source-hash').write_text(key)
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(staged)], check=True, timeout=30)
        old = Path(temp) / 'old.app'
        if contents.parent.exists():
            os.replace(contents.parent, old)
        try:
            os.replace(staged, contents.parent)
        except OSError:
            if old.exists():
                os.replace(old, contents.parent)
            raise
    return binary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['start', 'status', 'stop', 'mic', 'camera', 'sound', 'invite', 'prepare'])
    parser.add_argument('--app-home', required=True, type=Path)
    parser.add_argument('--parent-pid', type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    os.umask(0o077)
    home = args.app_home.resolve()
    folder = home / 'data/runespace-social'
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    commands = folder / 'commands'
    commands.mkdir(exist_ok=True, mode=0o700)
    kind = args.kind
    with (folder / 'control.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if kind == 'prepare':
            if not running(folder):
                build(folder)
            return {'ok': True}
        url = invite(home) if kind in ('invite', 'start', 'status') else None
        active = running(folder)
        if kind == 'status':
            state = read_json(folder / 'state.json') if active else {'connected': False, 'status': 'stopped'}
            return {**state, 'ok': True, 'configured': bool(url), 'running': active}
        if kind == 'invite':
            if not url:
                raise ValueError('Configure a team invitation first.')
            subprocess.run(['/usr/bin/pbcopy'], input=url, text=True, check=True, timeout=5)
            return {'ok': True, 'message': 'Guest invite copied.'}
        if kind == 'start':
            if active:
                return {'ok': True, 'running': True}
            if not url:
                return {'ok': True, 'configured': False, 'running': False}
            parent = args.parent_pid or desktop_pid()
            os.kill(parent, 0)
            exe = build(folder)
            for path in list(commands.glob('*.json')) + list(folder.glob('tile-*.rgba')):
                path.unlink(missing_ok=True)
            initial = dict(status='connecting', connected=False, mediaConnected=False, mic=False, camera=False,
                           error='', message='Joining the guild…', tiles=[], peers=[], updatedAt=time.time(), running=True)
            atomic(folder / 'state.json', json.dumps(initial).encode())
            with (folder / 'social.log').open('wb') as log:
                proc = subprocess.Popen([str(exe), str(home), str(parent)], stdin=subprocess.DEVNULL,
                                        stdout=log, stderr=log, start_new_session=True, close_fds=True)
            for _ in range(65):
                if running(folder):
                    return {'ok': True, 'configured': True, 'running': True}
                if proc.poll() is not None:
                    break
                time.sleep(.03)
            raise RuntimeError('The guild call helper could not start. Check data/runespace-social/social.log.')
        if not active:
            if kind == 'stop':
                return {'ok': True, 'running': False}
            raise ValueError('Join the guild call first.')
        if kind != 'stop' and not read_json(folder / 'state.json').get('mediaConnected'):
            raise ValueError('Voice and video have not connected yet.')
        atomic(commands / (str(time.time_ns()) + '.json'), json.dumps({'kind': kind}).encode())
        if kind == 'stop':
            deadline = time.monotonic() + 5
            while running(folder):
                if time.monotonic() >= deadline:
                    raise RuntimeError('The guild call is still closing. Try leaving again in a moment.')
                time.sleep(.05)
        return {'ok': True}


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
