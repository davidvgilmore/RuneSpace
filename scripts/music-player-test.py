#!/usr/bin/env python3
"""Exercise the official Bandcamp widget through the same commands the Herdr panel uses."""

from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time

MUSIC = Path(__file__).resolve().parents[1] / 'layout/mods/runespace/music'

# Only the test build attenuates playback and observes the underlying media clock.
PROBE = r'''
#if RUNESPACE_MUSIC_TEST
func configureProbe(_ config: WKWebViewConfiguration) {
    let script = """
        window.testMedia = new Set();
        const start = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function() {
            this.volume = 1e-12;
            window.testMedia.add(this);
            return start.apply(this, arguments);
        };
    """
    config.websiteDataStore = .nonPersistent()
    config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
}
func probeStation(_ station: Station) {
    let destination = station.home.appendingPathComponent("probe.json")
    var didSeek = false
    Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
        if !didSeek && FileManager.default.fileExists(atPath: station.home.appendingPathComponent("test-end").path) {
            station.web.evaluateJavaScript("""
                (() => {
                  const m = [...window.testMedia].find(m => !m.paused && !m.seeking && m.currentTime >= 1 && m.duration > 200 && m.duration < 230);
                  if (!m) return false;
                  m.currentTime = m.duration - .7;
                  return true;
                })()
            """) { value, _ in didSeek = value as? Bool == true }
        }
        station.web.evaluateJavaScript("Array.from(window.testMedia, m => ({time:Number.isFinite(m.currentTime) ? m.currentTime : 0,paused:m.paused,volume:m.volume}))") {
            value, _ in
            guard let media = value as? [[String: Any]] else { return }
            let snapshot: [String: Any] = ["audio": media, "visible": station.host.isVisible,
                                           "foreground": NSApp.isActive, "canActivate": NSApp.activationPolicy() != .prohibited]
            if let data = try? JSONSerialization.data(withJSONObject: snapshot) { try? data.write(to: destination, options: .atomic) }
        }
    }
}
#endif
'''

def main():
    with tempfile.TemporaryDirectory(prefix='runespace-embedded-music-') as directory:
        root = Path(directory)
        home = root / 'home'
        assets = home / 'mods/runespace/music'
        state = home / 'data/runespace-music'
        assets.mkdir(parents=True)
        shutil.copy2(MUSIC / 'control.py', assets / 'control.py')
        (assets / 'player.swift').write_text((MUSIC / 'player.swift').read_text() + '\n' + PROBE)
        env = os.environ.copy()

        def call(command, *args, app_home=home):
            result = subprocess.run([sys.executable, str(assets / 'control.py'), command, *args, '--app-home', str(app_home)],
                                    capture_output=True, text=True, env=env, timeout=150)
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)
            return json.loads(result.stdout)

        def read(name):
            file = state / name
            return json.loads(file.read_text()) if file.exists() else {}

        def wait(name, predicate, timeout=25):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                value = read(name)
                if predicate(value):
                    return value
                time.sleep(.18)
            raise AssertionError(f'Timeout on {name}: { {k:v for k,v in value.items() if k != "tracks"} }')

        def position(probe):
            assert not any(probe.get(key) for key in ['visible', 'foreground', 'canActivate']), probe
            return max((m['time'] for m in probe.get('audio', []) if not m['paused'] and m['volume'] < 1e-10), default=0)

        song = 'station-status.json'
        try:
            production = call('prepare')
            binary = Path(production['player'])
            assert production['ready'] and binary.is_file()
            subprocess.run(['/usr/bin/swiftc', '-swift-version', '5', '-O', '-D', 'RUNESPACE_MUSIC_TEST',
                            str(assets / 'player.swift'), '-o', str(binary)], check=True, timeout=100)
            assert not call('status')['running']
            # Earlier versions raise a window on every command except stop. A
            # read-only status must leave that process alone until transport is used.
            claimed = threading.Event()
            def legacy_station():
                with (state / 'station.lock').open('a+') as legacy_lock:
                    fcntl.flock(legacy_lock, fcntl.LOCK_EX)
                    (state / song).write_text(json.dumps({'pid': 12345, 'phase': 'ready'}))
                    claimed.set()
                    wait('station-request.json', lambda s: s.get('command') == 'stop', timeout=8)
            with ThreadPoolExecutor(max_workers=1) as legacy:
                old = legacy.submit(legacy_station)
                assert claimed.wait(2)
                assert call('status')['pid'] == 12345 and not (state / 'station-request.json').exists()
                opened = call('open')
                old.result()
                assert opened['pid'] != 12345 and opened['version'] == 2
            with ThreadPoolExecutor(max_workers=3) as pool:
                opens = list(pool.map(lambda _: call('open'), range(3)))
            pid = opens[0]['pid']
            assert all(s['running'] and s['pid'] == pid for s in opens)
            assert not call('stop', app_home=root / 'other-home')['running']
            initial = wait(song, lambda s: len(s.get('tracks', [])) == 43)
            assert initial['title'] == 'Scape Main' and not initial['playing']
            assert initial['tracks'][8] == {'number': 9, 'title': 'Sea Shanty 2', 'duration': 127}
            call('play', '--track', '9')
            wait(song, lambda s: s.get('playing') and s.get('track') == 9 and s.get('elapsed', 0) >= 1)
            wait('probe.json', lambda p: position(p) > 1)
            call('pause')
            paused = wait(song, lambda s: not s.get('playing'))
            wait('probe.json', lambda p: position(p) == 0)
            call('play')
            wait('probe.json', lambda p: position(p) > paused['elapsed'] + 1.3)
            # Showing/hiding the mod only inspects status. It never reselects or resets the track.
            assert call('open')['pid'] == pid
            call('play', '--track', '2')
            wait(song, lambda s: s.get('playing') and s.get('title') == 'Newbie Melody' and s.get('elapsed', 0) >= 1)
            (state / 'test-end').touch()
            wait(song, lambda s: s.get('playing') and s.get('track') == 3 and s.get('elapsed', 0) >= 1)
            call('next')
            wait(song, lambda s: s.get('playing') and s.get('track') == 4)
            call('previous')
            wait(song, lambda s: s.get('playing') and s.get('track') == 3)
            assert not call('stop')['running']
            assert not read(song)['running']
            assert not call('stop')['running']
            print('PASS: 43 official songs, windowless playback, select/pause/resume, natural advancement, next/previous, isolated singleton and stop')
        finally:
            call('stop')


if __name__ == '__main__':
    main()
