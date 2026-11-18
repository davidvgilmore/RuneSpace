#!/usr/bin/env python3
"""Muted integration check for native playback and heartbeat cleanup (macOS)."""
from pathlib import Path
import json, os, subprocess, tempfile, time
CONTROL=Path(__file__).resolve().parents[1]/'layout/mods/runespace/music/control.py'

def test():
    with tempfile.TemporaryDirectory(prefix='runespace-music-muted-test-') as folder:
        env=os.environ|{'RUNESPACE_MUSIC_STATE':folder}
        def call(*args):
            result=subprocess.run(['/usr/bin/python3',str(CONTROL),*args],env=env,capture_output=True,text=True,check=True,timeout=65)
            return json.loads(result.stdout)
        def wait(predicate,timeout=6):
            deadline=time.monotonic()+timeout;state={}
            while time.monotonic()<deadline:
                state=call('status')
                if predicate(state):return state
                time.sleep(.25)
            raise AssertionError(state)
        call('prepare')
        try:
            call('update','--playing','true','--active','true','--volume','0','--track','lanterns')
            state=wait(lambda s:s['player'].get('playing') and s['player'].get('position',0)>.2)
            assert state['player']['duration']>120 and state['player']['volume']==0
            call('heartbeat','--active','false')
            state=wait(lambda s:s['player'].get('reason')=='world-hidden');position=state['player']['position']
            time.sleep(.5);assert call('status')['player']['position']==position
            call('heartbeat','--active','true')
            wait(lambda s:s['player'].get('playing') and s['player'].get('position',0)>position+.2)
            call('update','--track','banners')
            state=wait(lambda s:s['player'].get('track')=='banners' and s['player'].get('playing'))
            assert state['player']['duration']>126 and state['player']['volume']==0
            call('update','--playing','false')
            wait(lambda s:s['player'].get('reason')=='paused' and not s['player'].get('playing'))
            call('update','--playing','true','--track','willow')
            wait(lambda s:s['player'].get('track')=='willow' and s['player'].get('playing'))
            control=Path(folder)/'control.json';data=json.loads(control.read_text());data['heartbeat']=0
            staged=control.with_suffix('.test-tmp');staged.write_text(json.dumps(data));staged.replace(control)
            state=wait(lambda s:not s['running'] and s['player'].get('reason')=='heartbeat-expired')
            assert not state['player']['playing']
            print('PASS: muted playback, duration, pause/resume, track switching, per-player volume, and stale-heartbeat exit')
        finally:
            call('stop');wait(lambda s:not s['running'])
if __name__=='__main__':test()
