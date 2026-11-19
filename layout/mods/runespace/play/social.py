#!/usr/bin/env python3
"""Control the one embedded guild call associated with a Herdr app home."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from launch import desktop_pid, read_json


def atomic(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        out.write(data)
    os.replace(out.name, path)


def guest_url(text):
    error = 'Copy a RuneSpace guild invite link and try again.'
    if not isinstance(text, str) or len(text) > 4096 or not text.isprintable() or any(ch.isspace() for ch in text) or '\\' in text:
        raise ValueError(error)
    try:
        url = urlsplit(text)
        local = url.hostname in ('localhost', '127.0.0.1', '::1')
        values = parse_qs(url.fragment, max_num_fields=12).get('invite', [])
        valid = (url.hostname and (url.scheme == 'https' or (local and url.scheme == 'http'))
                 and url.port != 0 and url.username is None and url.password is None and url.path in ('', '/')
                 and not url.query and len(values) == 1 and 16 <= len(values[0]) <= 512
                 and all(ch.isprintable() for ch in values[0]))
    except ValueError:
        raise ValueError(error) from None
    if not valid:
        raise ValueError(error)
    return urlunsplit((url.scheme, url.netloc, '/', '', urlencode({'invite': values[0]})))


def config_file(home):
    visit = home / 'data/runespace-visit.json'
    return visit if visit.exists() else home / 'data/runespace-team.json'


def load_config(file):
    if not file.exists():
        return {}
    try:
        config = json.loads(file.read_bytes())
        if not isinstance(config, dict) or not isinstance(config.get('url'), str):
            raise ValueError()
        return config
    except (ValueError, OSError):
        raise ValueError('The existing guild configuration could not be read.') from None


def owner_config(config):
    return bool(parse_qs(urlsplit(config.get('url', '')).fragment).get('owner'))


def invite(home):
    config = load_config(config_file(home))
    return guest_url(config.get('url')) if config else None


def configure_guest(home, text, name, share_agents, visit=False):
    file = config_file(home)
    existing = load_config(file)
    if file.name == 'runespace-team.json' and owner_config(existing):
        if not visit:
            raise RuntimeError('This desktop hosts a guild. Choose Visit another guild to join a guest invite.')
        file = home / 'data/runespace-visit.json'
    name = name.strip()
    if not 1 <= len(name) <= 32 or any(unicodedata.category(ch) in ('Cc', 'Cf') for ch in name):
        raise ValueError('Enter a display name of 1–32 characters.')
    config = {'url': guest_url(text.strip()), 'name': name, 'shareAgents': bool(share_agents)}
    atomic(file, json.dumps(config).encode())


def change_sharing(home, enabled):
    file = config_file(home)
    config = load_config(file)
    if not config:
        raise ValueError('Join a guild first.')
    if file.name == 'runespace-team.json' and owner_config(config):
        raise ValueError('This desktop already hosts the guild roster.')
    config['shareAgents'] = enabled
    atomic(file, json.dumps(config).encode())


def running(folder):
    with (folder / 'instance.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False


def stop_call(folder, commands):
    if not running(folder):
        return
    atomic(commands / (str(time.time_ns()) + '.json'), b'{"kind":"stop"}')
    deadline = time.monotonic() + 5
    while running(folder):
        if time.monotonic() >= deadline:
            raise RuntimeError('The guild call is still closing. Try again in a moment.')
        time.sleep(.05)


def build(folder):
    src = Path(__file__).resolve().with_name('social.swift')
    roster_src = src.with_name('GuildRoster.swift')
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
    key = hashlib.sha256(info + src.read_bytes() + roster_src.read_bytes()).hexdigest()
    stamp = contents / 'Resources/source-hash'
    if binary.is_file() and stamp.is_file() and stamp.read_text() == key:
        return binary
    with tempfile.TemporaryDirectory(dir=folder) as temp:
        staged = Path(temp) / (name + '.app')
        exe = staged / 'Contents/MacOS' / binary.name
        exe.parent.mkdir(parents=True)
        main_src = Path(temp) / 'main.swift'
        shutil.copyfile(src, main_src)
        subprocess.run(['/usr/bin/xcrun', 'swiftc', '-O', '-swift-version', '5', str(main_src), str(roster_src), '-o', str(exe)],
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
    parser.add_argument('kind', choices=['start', 'status', 'stop', 'mic', 'camera', 'sound', 'invite', 'prepare', 'join', 'return-home', 'share-on', 'share-off'])
    parser.add_argument('--app-home', required=True, type=Path)
    parser.add_argument('--parent-pid', type=int, help=argparse.SUPPRESS)
    parser.add_argument('--name', default='')
    parser.add_argument('--bring-agents', action='store_true')
    parser.add_argument('--visit', action='store_true', help='Visit another guild while preserving your host configuration.')
    parser.add_argument('--invite-stdin', action='store_true', help='Read a guild invite from stdin instead of the clipboard.')
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
        if kind == 'return-home':
            visit = home / 'data/runespace-visit.json'
            if not visit.exists():
                raise ValueError('This desktop is already at its home guild.')
            original = load_config(home / 'data/runespace-team.json')
            guest_url(original.get('url'))
            stop_call(folder, commands)
            visit.unlink()
            kind = 'start'
        if kind == 'join':
            if running(folder):
                raise ValueError('Leave the current call before joining another guild.')
            if args.invite_stdin:
                text = sys.stdin.read(4097)
            else:
                result = subprocess.run(['/usr/bin/pbpaste'], capture_output=True, check=True, timeout=5)
                text = result.stdout[:4097].decode('utf-8', errors='replace')
            configure_guest(home, text, args.name, args.bring_agents, visit=args.visit)
            kind = 'start'
        if kind in ('share-on', 'share-off'):
            change_sharing(home, kind == 'share-on')
            if running(folder):
                atomic(commands / (str(time.time_ns()) + '.json'), json.dumps({'kind': kind}).encode())
            return {'ok': True, 'shareAgents': kind == 'share-on'}
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
                snapshot = 'guild.snapshot' if Path(__file__).resolve().parents[1].name == 'guild-hall' else 'runespace.snapshot'
                proc = subprocess.Popen([str(exe), str(home), str(parent), snapshot], stdin=subprocess.DEVNULL,
                                        stdout=log, stderr=log, start_new_session=True, close_fds=True)
            for _ in range(65):
                if running(folder):
                    return {'ok': True, 'configured': True, 'running': True}
                if proc.poll() is not None:
                    break
                time.sleep(.03)
            raise RuntimeError('The guild call helper could not start. Check data/runespace-social/social.log.')
        if kind == 'stop':
            stop_call(folder, commands)
            return {'ok': True, 'running': False}
        if not active:
            raise ValueError('Join the guild call first.')
        if not read_json(folder / 'state.json').get('mediaConnected'):
            raise ValueError('Voice and video have not connected yet.')
        atomic(commands / (str(time.time_ns()) + '.json'), json.dumps({'kind': kind}).encode())
        return {'ok': True}


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
