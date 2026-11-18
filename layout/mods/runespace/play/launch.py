#!/usr/bin/env python3
"""Bind the RuneSpace layout to its own reusable local Herdr terminal."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from herdr_cli import find_cli

PRESENTER = HERE / 'presenter.py'
BUILD = HERE.parent / 'metal/control.py'
PYTHON = '/usr/bin/python3'
LOCAL_ADDRESS = re.compile(r't[0-9a-z]+\Z')


class LaunchError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def read_json(path):
    try:
        return json.loads(path.read_bytes())
    except (OSError, ValueError):
        return {}


def replace_json(path, value, mode=0o600):
    fd, temp = tempfile.mkstemp(prefix=path.name+'.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.write('\n')
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def update_layout(home, address=None):
    layout = home / 'layouts/runespace.json'
    for _ in range(4):
        try:
            source = layout.read_bytes()
            root = json.loads(source)
        except (OSError, ValueError) as exc:
            raise LaunchError('layout_unavailable', 'The RuneSpace layout could not be read.') from exc
        def stacks(node):
            if node.get('id') == 'main-stack' and node.get('type') == 'stack':
                yield node
            for child in node.get('children', []):
                yield from stacks(child)
        found = list(stacks(root))
        if len(found) != 1 or not isinstance(found[0].get('children'), list):
            raise LaunchError('layout_invalid', 'The Guild layout needs one main-stack container.')
        children = found[0]['children']
        games = [c for c in children if c.get('id') == 'runespace-game']
        if len(games) > 1 or (games and games[0].get('type') != 'block'):
            raise LaunchError('layout_invalid', 'The Guild game block has a conflicting definition.')
        if address is None:
            return (games[0].get('content') or {}).get('terminal') if games else None
        content = {'terminal': address}
        if games and games[0].get('content') == content:
            return
        if games:
            games[0]['content'] = content
        else:
            children.append({'id':'runespace-game', 'type':'block', 'content':content})
        # A layout editor may rewrite preferences independently of our launch lock.
        if layout.read_bytes() == source:
            replace_json(layout, root, layout.stat().st_mode & 0o777)
            return
    raise LaunchError('layout_busy', 'The Guild layout changed during binding. Open the world again.')


def desktop_pid():
    entries = subprocess.check_output(['/bin/ps', '-axww', '-o', 'pid=,ppid=,comm='], text=True)
    parents = {}
    desktops = set()
    for line in entries.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) != 3:
            continue
        pid, parent, command = parts
        parents[int(pid)] = int(parent)
        if not command.endswith('.app/Contents/MacOS/Herdr'):
            continue
        try:
            plist = Path(command).parents[1] / 'Info.plist'
            if plistlib.loads(plist.read_bytes()).get('CFBundleIdentifier') == 'dev.herdr.app':
                desktops.add(int(pid))
        except (OSError, ValueError, plistlib.InvalidFileException):
            continue
    # A user may run multiple app homes. Bind to the desktop that invoked this helper.
    parent = os.getppid()
    while parent in parents:
        if parent in desktops:
            return parent
        parent = parents.pop(parent)
    if len(desktops) == 1:
        return desktops.pop()
    if desktops:
        raise LaunchError('desktop_ambiguous', 'Enter the world from the RuneSpace layout in Herdr.')
    raise LaunchError('desktop_closed', 'Open Herdr to enter the Guild world.')


def hc(exe, args, missing_ok=False):
    run = subprocess.run([exe, *args], capture_output=True, text=True, timeout=9)
    try:
        response = json.loads(run.stdout or run.stderr)
    except ValueError as exc:
        raise LaunchError('core_error', (run.stderr or run.stdout).strip()[-400:] or 'The Herdr core did not respond.') from exc
    if run.returncode or 'error' in response:
        detail = response.get('error') or {}
        if missing_ok and detail.get('kind') == 'not_found':
            return None
        raise LaunchError('core_error', detail.get('message') or 'The Herdr core request failed.')
    return response


def owned(info, owner, name, home):
    if not info or not LOCAL_ADDRESS.fullmatch(info.get('address', '')) or info.get('name') != name:
        return False
    argv = info.get('argv') or []
    labels = info.get('labels') or {}
    return (len(argv) == 8 and labels.get('runespace.owner') == owner and labels.get('runespace.role') == 'world' and
            argv[:5] == [PYTHON, str(Path(__file__).resolve()), '--app-home', str(home), '--serve'])


def stop_child(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def parent_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def serve(home, generation, binary, parent):
    data = home / 'data/runespace-play'
    previous = None
    child = None
    def finish(_signum, _frame):
        raise SystemExit
    signal.signal(signal.SIGTERM, finish)
    signal.signal(signal.SIGHUP, finish)
    # Keep a single terminal ID across chat handoffs. The renderer only runs on
    # an explicit entry request. HC removes this terminal when the desktop exits.
    try:
        while parent_alive(parent):
            request = read_json(data / 'entry.json')
            if request.get('generation') not in (None, generation):
                break
            if request.get('generation') == generation and request.get('id') != previous:
                previous = request['id']
                # Entering is an explicit request. Reap any presenter still
                # handing off a previous conversation before assigning the PTY.
                stop_child(child)
                child = subprocess.Popen([PYTHON, str(PRESENTER), str(home), binary])
                replace_json(data / 'entry-ack.json', {'id':previous, 'generation':generation, 'pid':child.pid})
            if child and child.poll() is not None:
                child = None
            time.sleep(.075 if child else .15)
    finally:
        stop_child(child)


def launch(home, entry=None):
    data = home / 'data/runespace-play'
    data.mkdir(parents=True, mode=0o700, exist_ok=True)
    try:
        exe = find_cli('hc')
    except FileNotFoundError as exc:
        raise LaunchError('core_missing', str(exc)) from exc
    with (data / 'launch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous_address = update_layout(home)
        parent = desktop_pid()
        result = subprocess.run([PYTHON,str(BUILD),'prepare','--app-home',str(home)],
                                capture_output=True, text=True, timeout=105)
        prepared = json.loads(result.stdout or '{}')
        if result.returncode or not prepared.get('ready'):
            raise LaunchError('renderer_build_failed', prepared.get('error') or 'Metal could not prepare the Guild world.')
        binary = prepared['binary']
        owner = read_json(data / 'terminal-owner.json').get('owner')
        if not isinstance(owner, str) or not re.fullmatch(r'[0-9a-f]{32}',owner):
            owner = secrets.token_hex(16)
            replace_json(data / 'terminal-owner.json', {'owner':owner})
        # Version the name so an in-flight earlier build cannot take over the
        # new presenter. Older helpers stop on the new generation or desktop exit.
        version = hashlib.sha256((binary+str(parent)).encode()+PRESENTER.read_bytes()+Path(__file__).read_bytes()).hexdigest()[:8]
        name = f'runespace-world-{owner[:8]}-{version}'
        info = hc(exe, ['get','--json',name], missing_ok=True)
        reuse = info is not None and info.get('state') == 'live'
        if reuse and not owned(info, owner, name, home):
            raise LaunchError('terminal_conflict', 'A different terminal already has this world name.')
        generation = info['argv'][5] if reuse else secrets.token_hex(12)
        request = {'generation':generation, 'id':secrets.token_hex(12)}
        replace_json(data / 'entry.json', request)
        if not reuse:
            argv = [PYTHON,str(Path(__file__).resolve()),'--app-home',str(home),'--serve',generation,binary,str(parent)]
            info = hc(exe, ['run','--bg','--rm','--no-parent','--no-notify','--json','--name',name,
                            '--label','runespace.role=world','--label','runespace.owner='+owner,'--',*argv])
        address = info.get('address','')
        if not LOCAL_ADDRESS.fullmatch(address):
            raise LaunchError('terminal_unavailable', 'Herdr did not return a local terminal address.')
        current = hc(exe,['get','--json',address],missing_ok=True)
        if not owned(current, owner, name, home) or current.get('state') != 'live':
            raise LaunchError('terminal_unavailable', 'The Guild terminal closed before binding.')
        deadline = time.monotonic()+4
        while time.monotonic() < deadline:
            acknowledgment = read_json(data / 'entry-ack.json')
            if all(acknowledgment.get(k) == v for k,v in request.items()):
                # Binding a new terminal can reload the view that started this
                # request. Leave its acknowledged address for the new header.
                if entry is not None:
                    replace_json(data / 'accepted-entry.json', {'entry':entry, 'terminal':address})
                update_layout(home, address)
                if previous_address and previous_address != address and LOCAL_ADDRESS.fullmatch(previous_address):
                    # Retire only an older copy of this mod's verified private renderer.
                    old = hc(exe,['get','--json',previous_address],missing_ok=True)
                    if old and owned(old,owner,old.get('name'),home) and old.get('state')=='live':
                        try:
                            hc(exe,['kill','--json',previous_address],missing_ok=True)
                        except LaunchError:
                            # A --rm terminal can disappear between the kill request
                            # and its reply. Its verified absence completes retirement.
                            remaining=hc(exe,['get','--json',previous_address],missing_ok=True)
                            if remaining and remaining.get('state')=='live':
                                raise
                return {'ok':True,'terminal':address,'reused':reuse}
            time.sleep(.04)
        raise LaunchError('presenter_timeout', 'The Guild terminal did not acknowledge entry.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-home', type=Path, default=os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app'))
    parser.add_argument('--entry', type=int, help='Guild view entry timestamp')
    parser.add_argument('--serve', nargs=3, metavar=('GENERATION','BINARY','DESKTOP_PID'), help=argparse.SUPPRESS)
    args = parser.parse_args()
    home = args.app_home.expanduser().resolve()
    if args.serve:
        generation,binary,pid = args.serve
        serve(home,generation,binary,int(pid))
        return
    try:
        result = launch(home, args.entry)
    except (LaunchError,OSError,ValueError,subprocess.SubprocessError) as exc:
        result = {'ok':False,'code':getattr(exc,'code','launch_failed'),'error':str(exc)}
    print(json.dumps(result, separators=(',',':')))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
