#!/usr/bin/env python3
"""Install RuneSpace's status reporters for older harnesses on this machine."""
import argparse
import os
from pathlib import Path
import tempfile

INTEGRATIONS = Path(__file__).resolve().parents[1] / 'integrations'


def install(harness):
    if harness == 'pi':
        base = Path(os.getenv('PI_CODING_AGENT_DIR') or Path.home() / '.pi/agent')
        target = base / 'extensions/runespace-status'
    else:
        config = Path(os.getenv('XDG_CONFIG_HOME') or Path.home() / '.config')
        base = Path(os.getenv('OPENCODE_CONFIG_DIR') or config / 'opencode')
        target = base / 'plugins/runespace-status'
    target = target.expanduser()
    target.mkdir(parents=True, exist_ok=True)
    for source in sorted((INTEGRATIONS / harness).iterdir(), key=lambda file: file.name == 'package.json'):
        if not source.is_file() or source.suffix not in {'.ts', '.js', '.json', '.mjs'}:
            continue
        data = source.read_bytes()
        dest = target / source.name
        if dest.is_file() and dest.read_bytes() == data:
            continue
        with tempfile.NamedTemporaryFile(dir=target, delete=False) as tmp:
            tmp.write(data)
        os.replace(tmp.name, dest)
    print(f'Installed {harness} status reporter in {target}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('harness', nargs='+', choices=['pi', 'opencode'])
    for name in dict.fromkeys(parser.parse_args().harness):
        install(name)
