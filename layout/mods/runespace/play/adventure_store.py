"""Compare and replace adventure progress under the same lock as the Metal world."""
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile


def compare_and_save(home, expected, value):
    folder = home / 'data'
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / 'runespace-adventure.json'
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            current = path.read_text(encoding='utf-8')
        except FileNotFoundError:
            current = None
        if current != expected:
            return {'ok': False, 'current': current}
        with tempfile.NamedTemporaryFile(dir=folder, mode='w', encoding='utf-8', delete=False) as tmp:
            try:
                tmp.write(value)
                tmp.flush()
                os.replace(tmp.name, path)
            finally:
                Path(tmp.name).unlink(missing_ok=True)
        return {'ok': True, 'current': value}


if __name__ == '__main__':
    request = json.loads(sys.argv[2])
    print(json.dumps(compare_and_save(Path(sys.argv[1]), request['expected'], request['value'])))
