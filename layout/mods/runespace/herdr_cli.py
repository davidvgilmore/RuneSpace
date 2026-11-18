"""Find Herdr's installed command-line tools, including outside the GUI's PATH."""
import argparse
import os
from pathlib import Path
import shutil
import sys


def find_cli(name):
    home = Path.home()
    if name == 'hc':
        variable = 'RUNESPACE_HC'
        installed = [home / '.local/share/herdr-core/current/Contents/MacOS/herdr-core']
    elif name == 'herdr-app':
        variable = 'RUNESPACE_HERDR_APP'
        installed = [base / 'Herdr.app/Contents/MacOS/Herdr'
                     for base in (home / 'Applications', Path('/Applications'))]
    else:
        raise ValueError('Unknown Herdr executable ' + name)
    configured = os.environ.get(variable)
    if configured:
        candidates = [Path(configured).expanduser()]
    else:
        from_path = shutil.which(name)
        candidates = ([Path(from_path)] if from_path else []) + [home / '.local/bin' / name, *installed]
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            # Keep the installed tool's name, including for symlinked CLI entry points.
            return str(candidate.absolute())
    raise FileNotFoundError(f'Cannot find {name}. Set {variable} to the installed executable.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['status'])
    args = parser.parse_args()
    try:
        executable = find_cli('herdr-app')
        os.execv(executable, [executable, args.command])
    except OSError as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
