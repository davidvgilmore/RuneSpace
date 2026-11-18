#!/usr/bin/env python3
"""Build and run the Guild mod's local Metal presentation window."""
import argparse
import fcntl
import hashlib
import json
import os
import plistlib
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ASSETS = Path(__file__).resolve().parent
SOURCES = sorted(ASSETS.glob('*.swift'))
BUNDLE_ID = 'dev.runespace.herdr.world'


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def build(state):
    manifest = plistlib.dumps({
        'CFBundleDevelopmentRegion': 'en', 'CFBundleDisplayName': 'RuneSpace',
        'CFBundleExecutable': 'GuildWorld', 'CFBundleIdentifier': BUNDLE_ID,
        'CFBundleInfoDictionaryVersion': '6.0', 'CFBundleName': 'RuneSpace',
        'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': '1.0',
        'CFBundleVersion': '1', 'LSUIElement': True, 'NSHighResolutionCapable': True,
    })
    signature = hashlib.sha256(manifest + b''.join(p.read_bytes() for p in SOURCES)).hexdigest()[:16]
    release = state / signature
    app = release / 'Guild World.app'
    relative_binary = Path('Contents/MacOS/GuildWorld')
    binary = app / relative_binary
    if binary.is_file():
        return binary
    temporary = Path(tempfile.mkdtemp(prefix='build-', dir=state))
    try:
        staged = temporary / app.name
        target = staged / relative_binary
        target.parent.mkdir(parents=True)
        (staged/'Contents/Info.plist').write_bytes(manifest)
        subprocess.run(['/usr/bin/swiftc', '-swift-version', '5', '-O', *SOURCES, '-o', target],
                       check=True, capture_output=True, text=True, timeout=90)
        target.chmod(0o700)
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', staged],
                       check=True, capture_output=True, text=True, timeout=20)
        try:
            temporary.rename(release)
        except OSError:
            if not binary.is_file():
                raise
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return binary


def valid_owner(record, state):
    try:
        pid = int(record['pid'])
        binary = Path(record['binary'])
        relative = binary.relative_to(state)
        packaged = len(relative.parts) == 5 and len(relative.parts[0]) == 16 and relative.parts[1:] == (
            'Guild World.app', 'Contents', 'MacOS', 'GuildWorld')
        # Also recognize a helper opened before the change to an application bundle.
        previous = binary.parent == state and binary.name.startswith('GuildWorld-')
        if not (packaged or previous) or pid <= 1:
            return False
        result = subprocess.run(['/bin/ps', '-ww', '-p', str(pid), '-o', 'comm='], capture_output=True,
                                text=True, timeout=2)
        return result.returncode == 0 and result.stdout.strip() == str(binary)
    except (KeyError, ValueError, OSError, subprocess.SubprocessError):
        return False


def run(action, home):
    data = home / 'data'
    state = data / 'runespace-metal'
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    bench = action == 'benchmark'
    slot = 'benchmark' if bench else 'window'
    status = data / ('runespace-metal-bench-status.json' if bench else 'runespace-metal-status.json')
    owner = state / (slot + '.json')
    with (state / (slot + '.lock')).open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = load(owner)
        running = valid_owner(record, state)
        if action == 'status':
            return {**load(status), 'running': running}
        if action == 'stop':
            if running:
                os.kill(record['pid'], signal.SIGTERM)
            return {'ok': True, 'running': False}
        if running:
            if action == 'open':
                # The helper listens for SIGUSR1 using a dispatch source.
                os.kill(record['pid'], signal.SIGUSR1)
                return {'ok': True, 'running': True, 'pid': record['pid']}
            if bench:
                raise RuntimeError('Benchmark already running')
        binary = build(state)
        if action == 'prepare':
            return {'ready': True, 'binary': str(binary)}
        for name in ['engine.bundle.js', 'assets.json']:
            if not (ASSETS / name).is_file():
                raise RuntimeError('Missing Guild asset: ' + name)
        with (state / (slot + '.log')).open('wb') as log:
            proc = subprocess.Popen([binary, ASSETS, home, slot], stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=log, start_new_session=True)
        owner.write_text(json.dumps({'pid': proc.pid, 'binary': str(binary)}))
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            response = load(status)
            if response.get('pid') == proc.pid and response.get('running'):
                break
            if proc.poll() is not None:
                tail = (state / (slot + '.log')).read_text(errors='replace')[-1000:]
                raise RuntimeError(response.get('error') or tail or 'The world closed during launch')
            time.sleep(.05)
        else:
            proc.terminate()
            raise RuntimeError('Metal window did not acknowledge startup')
    if bench:
        try:
            proc.wait(timeout=45)
        except subprocess.TimeoutExpired:
            proc.terminate()
            raise RuntimeError('Benchmark did not complete')
        result = load(data / 'runespace-metal-benchmark.json')
        if result.get('pid') != proc.pid or not result.get('scenarios'):
            raise RuntimeError('No completed presented-frame measurements')
        return result
    return {**response, 'ok': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('prepare', 'open', 'stop', 'status', 'benchmark'))
    parser.add_argument('--app-home', type=Path, default=os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app'))
    args = parser.parse_args()
    try:
        result = run(args.command, args.app_home.expanduser().resolve())
    except Exception as err:
        message = err.stderr if isinstance(err,subprocess.CalledProcessError) else str(err)
        print(json.dumps({'ok':False,'error':message})); sys.exit(1)
    print(json.dumps(result,separators=(',',':')))


if __name__ == '__main__':
    main()
