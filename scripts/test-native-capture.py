#!/usr/bin/env python3
"""Run on a Mac with an active graphical session. Uses only WebKit's synthetic devices."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
FIXTURES = SCRIPTS / 'fixtures'
PLAY = next((SCRIPTS.parent / 'layout/mods').glob('*/play/social.swift')).parent
sys.path.insert(0, str(PLAY))
import social


class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/embedded-guild.html':
            self.send_error(404)
            return
        data = (FIXTURES / 'capture-page.html').read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def build_fixture(directory):
    bundle = directory / 'Capture Fixture.app'
    contents = bundle / 'Contents'
    exe = contents / 'MacOS/Fixture'
    exe.parent.mkdir(parents=True)
    main = directory / 'main.swift'
    shutil.copy2(PLAY / 'social.swift', main)
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-D', 'GUILD_CAPTURE_FIXTURE',
                    str(main), str(PLAY / 'GuildRoster.swift'), str(FIXTURES / 'GuildCaptureFixture.swift'),
                    '-o', str(exe)], check=True, timeout=90)
    (contents / 'Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': 'dev.runespace.test.capture', 'CFBundleExecutable': exe.name,
        'CFBundleName': 'RuneSpace Capture Test', 'CFBundlePackageType': 'APPL', 'LSUIElement': True,
        'NSCameraUsageDescription': 'WebKit test camera.', 'NSMicrophoneUsageDescription': 'WebKit test microphone.'
    }))
    subprocess.run(['codesign', '--force', '--sign', '-', str(bundle)], check=True)
    return exe


def exercise(home, port):
    exe = build_fixture(home)
    data = home / 'data'
    data.mkdir()
    (data / 'runespace-team.json').write_text(json.dumps({'url': f'http://127.0.0.1:{port}/#invite=test-capture-fixture'}))
    state = data / 'runespace-social/state.json'

    def control(command):
        argv = ['social.py', command, '--app-home', str(home), '--parent-pid', str(os.getpid())]
        with patch.object(sys, 'argv', argv), patch.object(social, 'build', return_value=exe):
            assert social.main()['ok']

    def expect(condition):
        last = {}
        start = time.monotonic()
        while time.monotonic() - start < 10:
            if state.exists():
                last = json.loads(state.read_bytes())
                if condition(last):
                    return last
            time.sleep(.05)
        raise AssertionError(last)

    try:
        control('start')
        expect(lambda v: v.get('visibility') == 'hidden' and v['mediaConnected'] and not v['mic'] and not v['camera'])
        control('mic')
        expect(lambda v: v.get('micPending') and v.get('visibility') == 'visible')
        expect(lambda v: 'Privacy' in v.get('error', '') and not v['mic'] and v['visibility'] == 'hidden')
        (home / 'approved').touch()
        control('mic')
        control('camera')
        on = expect(lambda v: v.get('mic') and v.get('camera') and v.get('visibility') == 'hidden')
        assert len(on['labels']) == 2 and all('mock' in text.lower() for text in on['labels']), on
        control('mic')
        control('camera')
        expect(lambda v: v.get('labels') == [] and not v['mic'] and not v['camera'] and v['mediaConnected'])
    finally:
        control('stop')


if __name__ == '__main__':
    with ThreadingHTTPServer(('127.0.0.1', 0), Page) as server, tempfile.TemporaryDirectory() as tmp:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            exercise(Path(tmp), server.server_port)
        finally:
            server.shutdown()
    print('Passed native camera and microphone consent, retry, hidden capture, and mute.')
