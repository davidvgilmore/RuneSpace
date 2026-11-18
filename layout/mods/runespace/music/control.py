#!/usr/bin/env python3
"""Quiet native soundtrack control, scoped entirely to the RuneSpace mod.

update --playing true --active true --track lanterns --volume .30
heartbeat --active true        # every ~5 seconds while in the world or an agent conversation
heartbeat --active false       # pauses immediately when opening the overview or terminals
status | prepare | stop
"""
from pathlib import Path
import argparse, fcntl, hashlib, json, os, subprocess, sys, time
ASSETS=Path(__file__).resolve().parent
# The installed controller lives under <app-home>/mods/runespace/music.
APP_HOME = Path(os.environ.get('HERDR_APP_HOME', ASSETS.parents[2])).expanduser()
STATE = Path(os.environ.get('RUNESPACE_MUSIC_STATE', APP_HOME/'data/runespace-music')).expanduser()
DEFAULT=dict(playing=False,active=False,volume=.30,track='lanterns',heartbeat=0,quit=False)

def read(path,default):
    try:return json.loads(path.read_text())
    except (OSError,ValueError):return default.copy()
def write(path,value):
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value,separators=(',',':')));temp.chmod(0o600);temp.replace(path)
def prepare():
    source=ASSETS/'player.swift';digest=hashlib.sha256(source.read_bytes()).hexdigest();binary=STATE/'player'
    recorded=(STATE/'player.sha256').read_text().strip() if (STATE/'player.sha256').exists() else ''
    if not binary.exists() or recorded!=digest:
        built=STATE/'player.build'
        result=subprocess.run(['/usr/bin/swiftc','-O',str(source),'-o',str(built)],capture_output=True,text=True,timeout=60)
        if result.returncode:raise RuntimeError('Music player compilation failed: '+result.stderr[-1500:])
        built.chmod(0o700);built.replace(binary);(STATE/'player.sha256').write_text(digest)
    return binary

def running():
    with (STATE/'player.lock').open('a+') as handle:
        try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return True
        fcntl.flock(handle,fcntl.LOCK_UN);return False

def main():
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command',choices=['prepare','update','heartbeat','status','stop'])
    parser.add_argument('--playing',choices=['true','false']);parser.add_argument('--active',choices=['true','false'])
    parser.add_argument('--track');parser.add_argument('--volume',type=float)
    args=parser.parse_args();STATE.mkdir(parents=True,exist_ok=True);STATE.chmod(0o700)
    with (STATE/'control.lock').open('a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if args.command=='prepare':print(json.dumps({'ready':True,'player':str(prepare())}));return
        control=DEFAULT|read(STATE/'control.json',DEFAULT)
        if args.command=='status':print(json.dumps({'control':control,'player':read(STATE/'status.json',{}),'running':running()}));return
        if args.command=='stop':control.update(playing=False,active=False,quit=True)
        else:
            control['quit']=False
            if args.playing is not None:control['playing']=args.playing=='true'
            if args.active is not None:control['active']=args.active=='true'
            if args.volume is not None:control['volume']=max(0,min(1,args.volume))
            if args.track:
                known={t['id'] for t in read(ASSETS/'manifest.json',{}).get('tracks',[])}
                if args.track not in known:raise ValueError('Unknown music track')
                control['track']=args.track
        control['heartbeat']=time.time();write(STATE/'control.json',control)
        if control['playing'] and control['active'] and not running():
            binary=prepare()
            with (STATE/'player.log').open('ab') as log:
                subprocess.Popen([str(binary),str(STATE),str(ASSETS)],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,close_fds=True)
        print(json.dumps({'ok':True,'playing':control['playing'],'active':control['active'],'track':control['track'],'volume':control['volume']}))
if __name__=='__main__':
    try:main()
    except Exception as error:print(json.dumps({'ok':False,'error':str(error)}));sys.exit(1)
