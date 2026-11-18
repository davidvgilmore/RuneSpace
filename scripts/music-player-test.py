#!/usr/bin/env python3
"""Run the native music window against the live Bandcamp widget on a Mac with a GUI.

The temporary test build attenuates audio below -200 dB and inspects the
rendered widget. Production uses Bandcamp's player without injected scripts.
"""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

MUSIC = Path(__file__).resolve().parents[1] / 'layout/mods/runespace/music'

# This compiles only in the disposable copy of the helper. Exercise the widget's
# controls without touching the system cursor or the user's audio settings.
PROBE = r'''
func configureProbe(_ config: WKWebViewConfiguration) {
    let mute = """
        window.testMedia = new Set();
        const originalPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function() {
            // At -240 dB the test signal is below a 24-bit output's noise floor.
            // WebKit pauses elements marked muted on minimize to conserve power.
            this.volume = 1e-12;
            window.testMedia.add(this);
            return originalPlay.apply(this, arguments);
        };
    """
    config.userContentController.addUserScript(WKUserScript(source: mute, injectionTime: .atDocumentStart, forMainFrameOnly: true))
}

func clickWidget(_ station: Station, _ selector: String) {
    // WKWebView evaluates UI-initiated JavaScript with a user gesture.
    // Activating the widget's own control also works with another app focused.
    let activate = """
      (() => {
        const control = [...document.querySelectorAll('\(selector)')].find(e => e.getClientRects().length && e.offsetWidth > 8);
        if (control) { control.click(); }
      })()
    """
    station.web.evaluateJavaScript(activate)
}

func probeStation(_ station: Station) {
    var lastInstruction = ""
    let instruction = station.home.appendingPathComponent("probe-command")
    let result = station.home.appendingPathComponent("probe.json")
    let inspect = """
        (() => {
          const media = [...window.testMedia];
          return {
            titles: [...document.querySelectorAll('#tracklist_ul > li')].map(e => e.innerText.trim()),
            selected: [document.querySelector('#currenttitle_title')?.textContent,
                       document.querySelector('#tracknamelink')?.textContent].join(' '),
            audio: media.map(m => ({volume:m.volume, paused:m.paused, time:m.currentTime, network:m.networkState,
                                     error:m.error?.code ?? null})),
            clock: document.querySelector('#currenttimeblock')?.innerText ?? ''
          };
        })()
    """
    Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
        if let command = try? String(contentsOf: instruction, encoding: .utf8), command != lastInstruction {
            lastInstruction = command
            switch command {
            case "play": clickWidget(station, "#play, #big_play_button")
            case "next": clickWidget(station, "#next")
            case "minimize": station.window.miniaturize(nil)
            case "close": station.window.performClose(nil)
            default: break
            }
        }
        station.web.evaluateJavaScript(inspect) { snapshot, _ in
            guard let snapshot = snapshot as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: snapshot) else { return }
            try? data.write(to: result, options: .atomic)
        }
    }
}
'''


def main():
    with tempfile.TemporaryDirectory(prefix='runespace-bandcamp-test-') as directory:
        root = Path(directory)
        home = root / 'home'
        assets = home / 'mods/runespace/music'
        state = home / 'data/runespace-music'
        assets.mkdir(parents=True)
        shutil.copy2(MUSIC / 'control.py', assets / 'control.py')
        source = (MUSIC / 'player.swift').read_text()
        (assets / 'player.swift').write_text(source + '\n' + PROBE)
        env = os.environ.copy()
        env.pop('RUNESPACE_MUSIC_STATE', None)

        def call(command, app_home=home):
            result = subprocess.run([sys.executable, str(assets / 'control.py'), command, '--app-home', str(app_home)],
                                    capture_output=True, text=True, env=env, timeout=135)
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)
            return json.loads(result.stdout)

        def snapshot():
            file = state / 'probe.json'
            return json.loads(file.read_text()) if file.exists() else {}

        def wait(get, predicate, timeout=22):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                value = get()
                if predicate(value):
                    return value
                time.sleep(.15)
            raise AssertionError(f'Timed out, last observation: {value}')

        def command(action):
            temp = state / 'probe-command.tmp'
            temp.write_text(action)
            temp.replace(state / 'probe-command')

        def position(snapshot):
            return max([m['time'] for m in snapshot.get('audio', []) if m['volume'] < 1e-10 and not m['paused']], default=0)

        try:
            production = call('prepare')
            binary = Path(production['player'])
            assert production['ready'] and binary.is_file()
            subprocess.run(['/usr/bin/swiftc', '-swift-version', '5', '-O', '-D', 'RUNESPACE_MUSIC_TEST',
                            str(assets / 'player.swift'), '-o', str(binary)], check=True, timeout=100)
            with ThreadPoolExecutor(max_workers=3) as pool:
                opens = list(pool.map(lambda _: call('open'), range(3)))
            pid = opens[0]['pid']
            assert all(s['running'] and s['pid'] == pid for s in opens)
            assert call('stop', root / 'other-home') == {'ok': True, 'running': False}
            assert call('status')['pid'] == pid
            initial = wait(snapshot, lambda s: len(s.get('titles', [])) == 43)
            assert 'Scape Main' in initial['selected'] and 'Sea Shanty 2' in ' '.join(initial['titles'])
            assert position(initial) == 0
            command('play')
            wait(snapshot, lambda s: position(s) > 0.8)
            command('minimize')
            wait(lambda: call('status'), lambda s: s['minimized'])
            before = position(snapshot())
            wait(snapshot, lambda s: position(s) > before + 1)
            reopened = call('open')
            assert reopened['pid'] == pid and not reopened['minimized']
            wait(snapshot, lambda s: position(s) > before + 1.3)
            command('next')
            advanced = wait(snapshot, lambda s: s.get('selected') != initial['selected'] and position(s) > .4)
            assert 'Newbie Melody' in advanced['selected']
            command('close')
            wait(lambda: call('status'), lambda s: not s['running'])
            new = call('open')
            assert new['running'] and new['pid'] != pid
            assert not call('stop')['running']
            assert not call('stop')['running']
            print('PASS: 43 official tracks, Scape Main on open, visible Next selects Newbie Melody, muted playback across minimize and restore, singleton, isolated stop and clean close.')
        finally:
            call('stop')


if __name__ == '__main__':
    main()
