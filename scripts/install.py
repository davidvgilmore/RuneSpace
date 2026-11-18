#!/usr/bin/env python3
"""Build and install the RuneSpace user mod in a Herdr app home."""
import argparse
import filecmp
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'layout'
MOD = Path('mods/runespace')
MUSIC_PANEL = Path('mods/runespace-music')
LAYOUT = Path('layouts/runespace.json')
METAL_OUTPUT = {'assets.json', 'engine.bundle.js'}
HERDR_GENERATED = {'gpui-kit.d.ts', 'jsconfig.json'}


def main_stack(node):
    if not isinstance(node, dict):
        return None
    if node.get('id') == 'main-stack' and node.get('type') == 'stack':
        return node
    for child in node.get('children', []):
        stack = main_stack(child)
        if stack is not None:
            return stack
    return None


def restore_game_binding(existing, staged):
    """Keep the terminal Herdr assigned to this user's embedded RuneSpace world."""
    if not existing.is_file():
        return
    current = main_stack(json.loads(existing.read_text()))
    layout = json.loads(staged.read_text())
    stack = main_stack(layout)
    if current is None or stack is None:
        return
    for item in current.get('children', []):
        if item.get('id') == 'runespace-game' and item.get('type') == 'block':
            terminal = item.get('content', {}).get('terminal')
            if isinstance(terminal, str) and re.fullmatch(r't[0-9a-z]+', terminal):
                game = next((c for c in stack['children'] if c.get('id') == 'runespace-game'), None)
                if game is None:
                    stack['children'].append({'id': 'runespace-game', 'type': 'block', 'content': {'terminal': terminal}})
                elif game.get('type') == 'block':
                    game['content'] = {'terminal': terminal}
                break
    active = current.get('active')
    if active in {item['id'] for item in stack['children']}:
        stack['active'] = active
    staged.write_text(json.dumps(layout, indent=2, ensure_ascii=False) + '\n')


def stage_mod(stage, mod):
    mod_files = SOURCE / mod
    for source in sorted(mod_files.rglob('*')):
        relative = source.relative_to(mod_files)
        if not source.is_file() or any(p.startswith('.') or p == '__pycache__' for p in relative.parts):
            continue
        if (source.name in HERDR_GENERATED or source.suffix in {'.pyc', '.pyo'}
                or (relative.parent == Path('metal') and source.name in METAL_OUTPUT)):
            continue
        destination = stage / mod / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def stage_files(stage):
    for mod in (MUSIC_PANEL, MOD):
        stage_mod(stage, mod)
    for relative in [LAYOUT, Path('layouts/runespace.svg'), Path('themes/runespace.json')]:
        destination = stage / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SOURCE / relative, destination)
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Install Node.js 22 or later and put node on PATH to build the RuneSpace world.')
    subprocess.run([node, ROOT / 'scripts/build-metal-assets.mjs', stage / MOD / 'metal'], check=True)


def retire_legacy_music(app_home):
    """Move the previous bundled soundtrack out of the mod, preserving local edits."""
    mod = app_home / MOD
    music = mod / 'music'
    manifest = music / 'manifest.json'
    if not manifest.is_file():
        return
    try:
        catalog = json.loads(manifest.read_text())
    except (UnicodeError, ValueError):
        return
    if not isinstance(catalog, dict) or catalog.get('title') != 'Songs of the Guild':
        return
    tracks = catalog.get('tracks')
    if not isinstance(tracks, list):
        return
    files = [mod / 'world-music.js']
    for track in tracks:
        key = track.get('id') if isinstance(track, dict) else None
        if isinstance(key, str) and re.fullmatch('[a-z0-9-]+', key):
            files.extend(music / (key + suffix) for suffix in ('.m4a', '.mid', '.score.json'))
    archive = Path(tempfile.mkdtemp(prefix='runespace-legacy-music-', dir=app_home / 'data'))
    # Move the manifest last so that a later run can finish an interrupted migration.
    for file in [*files, manifest]:
        if file.is_file():
            file.rename(archive / file.name)


def publish(stage, app_home):
    restore_game_binding(app_home / LAYOUT, stage / LAYOUT)
    # A fresh mod first becomes visible with all of its assets present.
    for mod in (MUSIC_PANEL, MOD):
        mod_dir = app_home / mod
        if not mod_dir.exists():
            mod_dir.parent.mkdir(parents=True, exist_ok=True)
            (stage / mod).rename(mod_dir)
    # On updates replace individual files atomically and keep Herdr's own files.
    # Publish the manifest and layout after their dependencies are in place.
    last = {MUSIC_PANEL / 'mod.json': 1, MOD / 'mod.json': 1, LAYOUT: 2}
    sources = [p for p in stage.rglob('*') if p.is_file()]
    for source in sorted(sources, key=lambda p: (last.get(p.relative_to(stage), 0), p)):
        target = app_home / source.relative_to(stage)
        if target.is_file() and filecmp.cmp(source, target, shallow=False):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, target)
    retire_legacy_music(app_home)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-home', type=Path,
                        default=os.environ.get('HERDR_APP_HOME', Path.home()/'.config/herdr-app'),
                        help='Herdr configuration directory (default: HERDR_APP_HOME or ~/.config/herdr-app)')
    args = parser.parse_args()
    app_home = args.app_home.expanduser().resolve()
    app_home.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.runespace-install-', dir=app_home) as scratch:
        stage = Path(scratch)
        stage_files(stage)
        # The launcher writes its assigned terminal into the layout under this same lock.
        state = app_home / 'data/runespace-play'
        state.mkdir(parents=True, mode=0o700, exist_ok=True)
        with (state / 'launch.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            publish(stage, app_home)
    print('Installed RuneSpace in ' + str(app_home))
    print('Select RuneSpace in Herdr’s layout picker, or run:')
    print('  herdr-app do layout.switch \'{"name":"runespace"}\'')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(f'RuneSpace installation failed: {error}')
