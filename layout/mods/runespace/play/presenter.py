#!/usr/bin/env python3
"""Present the Guild's Metal framebuffer inside a private Herdr terminal."""
import base64
import ctypes
import fcntl
import json
import math
import os
from pathlib import Path
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import tty
import zlib
from minimap import Minimap

ESC = b'\x1b'
CSI = ESC + b'['
END = ESC + b'\\'
HOME = Path(sys.argv[1])
METAL = Path(__file__).resolve().parents[1] / 'metal'
DATA = HOME / 'data'
EVENT = DATA / 'runespace-metal-event.json'
RATE = 60
FOOTER_ACTIONS = (('[G Dance]', 'dance'), ('[I Inventory]', 'inventory'), ('[M Music]', 'music'))
FOOTER_BUTTONS = '  '.join(label for label, _ in FOOTER_ACTIONS)
IMAGE_IDS = (2718, 2719, 2720)
MOUSE = re.compile(rb'\x1b\[<(\d+);(\d+);(\d+)([mM])')
KEY = re.compile(rb'\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?u')
CELL_SIZE = re.compile(rb'\x1b\[6;(\d+);(\d+)t')
ARROW = re.compile(rb'\x1b(?:\[1?(?:;\d+(?::([123]))?)?|O)([ABCD])')
ARROWS = {b'A':'up', b'B':'down', b'C':'right', b'D':'left'}
GAME_KEYS = frozenset(('a','s','d','f','q','w','e','r','left','right','down','up'))
# Discrete camera travel for press-only terminals, in radians per key event.
CAMERA_STEPS = {'a':('orbit',-.035),'q':('orbit',-.035),'d':('orbit',.035),'e':('orbit',.035),
                'w':('tilt',.028),'r':('tilt',.028),'s':('tilt',-.028),'f':('tilt',-.028)}


def read_json(path):
    try:
        return json.loads(path.read_bytes())
    except (OSError, ValueError):
        return {}


def atomic_json(path, obj):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(obj))
    temp.replace(path)


def output(buf):
    view = memoryview(buf)
    while view:
        view = view[os.write(1, view):]


def screen_size():
    rows, cols, xp, yp = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0'*8))
    return max(rows,4), max(cols,10), xp, yp


def safe_title(text, limit):
    return ''.join(ch for ch in str(text) if ch.isprintable())[:limit]


class FrameCompressor:
    """Reuse libdeflate's encoder when present, and retain the system zlib path."""
    def __init__(self):
        self.handle = None
        self.buffer = None
        pointer, size = ctypes.c_void_p, ctypes.c_size_t
        for path in ('/opt/homebrew/lib/libdeflate.dylib', '/usr/local/lib/libdeflate.dylib'):
            try:
                lib = ctypes.CDLL(path)
                lib.libdeflate_alloc_compressor.argtypes = [ctypes.c_int]
                lib.libdeflate_alloc_compressor.restype = pointer
                lib.libdeflate_zlib_compress.argtypes = [pointer,pointer,size,pointer,size]
                lib.libdeflate_zlib_compress.restype = size
                lib.libdeflate_zlib_compress_bound.argtypes = [pointer,size]
                lib.libdeflate_zlib_compress_bound.restype = size
                lib.libdeflate_free_compressor.argtypes = [pointer]
                lib.libdeflate_free_compressor.restype = None
                self.handle = lib.libdeflate_alloc_compressor(1)
                if self.handle:
                    self.lib = lib
                    break
            except (OSError, AttributeError):
                continue

    def encode(self, raw):
        if self.handle:
            capacity = self.lib.libdeflate_zlib_compress_bound(self.handle, len(raw))
            if self.buffer is None or len(self.buffer) < capacity:
                self.buffer = ctypes.create_string_buffer(capacity)
            source = (ctypes.c_ubyte * len(raw)).from_buffer(raw)
            length = self.lib.libdeflate_zlib_compress(self.handle,source,len(raw),self.buffer,capacity)
            if length:
                return memoryview(self.buffer).cast('B')[:length]
        return zlib.compress(raw,1)

    def close(self):
        if self.handle:
            self.lib.libdeflate_free_compressor(self.handle)
            self.handle = None


def kitty_image(raw, width, height, cols, rows, index, compressor):
    # Replacing Kitty pixel data also removes the image's placements. Upload into
    # the oldest slot so the previous two frames remain visible during decoding.
    image_id = IMAGE_IDS[index % len(IMAGE_IDS)]
    data = base64.b64encode(compressor.encode(raw))
    params = f'a=t,i={image_id},t=d,f=32,o=z,q=2,s={width},v={height},'.encode()
    chunks = []
    for i in range(0, len(data), 4096):
        more = b'1' if i+4096 < len(data) else b'0'
        chunks.extend([ESC+b'_G',params if i==0 else b'',b'm='+more+b';',data[i:i+4096],END])
    z = 1 + index % 2_147_483_647
    placement = f'a=p,i={image_id},p=1,q=2,C=1,z={z},c={cols},r={rows};'.encode()
    return b''.join(chunks), ESC+b'_G'+placement+END


class FocusedGameKeys:
    """Held keys reported by the focused GPUI game control for this entry only."""
    def __init__(self, path, entry):
        self.path=path
        self.entry=entry
        self.stamp=None
        self.sequence=-1
        self.last_action=-1
        self.keys=set()
        self.presses={}
        self.expires=0

    def sample(self, now_ms, apply_action=None):
        if self.entry is None:return set()
        try:
            stat=self.path.stat()
        except OSError:
            self.keys.clear()
            self.stamp=None
            return set()
        stamp=(stat.st_ino,stat.st_mtime_ns,stat.st_size)
        taps=set()
        if stamp!=self.stamp:
            self.stamp=stamp
            data=read_json(self.path)
            if not isinstance(data,dict) or data.get('entry')!=self.entry:
                self.keys.clear()
                return set()
            seq,at,keys=data.get('seq'),data.get('at'),data.get('keys')
            if isinstance(seq,int) and seq>self.sequence and isinstance(at,(float,int)) and isinstance(keys,list):
                counts=data.get('presses',{})
                if not isinstance(counts,dict):counts={}
                if self.sequence>=0:
                    # A fast tap can begin and finish between two rendered frames.
                    taps={key for key,count in counts.items() if key in GAME_KEYS and
                          isinstance(count,int) and count>self.presses.get(key,0)}
                self.presses={key:value for key,value in counts.items() if key in GAME_KEYS and isinstance(value,int)}
                self.sequence=seq
                self.keys={key for key in keys if isinstance(key,str) and key in GAME_KEYS}
                self.expires=at+650 if at<=now_ms+100 else 0
                actions=data.get('actions',[])
                if apply_action and now_ms<=self.expires and isinstance(actions,list):
                    for action in actions:
                        if not isinstance(action,dict):continue
                        number=action.get('seq')
                        if not isinstance(number,int) or number<=self.last_action:continue
                        self.last_action=number
                        stamp=action.get('at',at)
                        if not isinstance(stamp,(int,float)) or not -100<=now_ms-stamp<=650:continue
                        kind=action.get('kind')
                        if kind in ('names','nearest','cancel','music','inventory','home','dance'):
                            apply_action(action)
                        elif kind=='zoom' and isinstance(action.get('delta'),(float,int)):
                            apply_action(action)
        if now_ms>self.expires:
            self.keys.clear()
            return set()
        return self.keys | taps


class Controls:
    def __init__(self):
        self.explicit_keys = set()
        self.seen_release = False
        self.first_frame_keys = set()
        self.focused = True
        self.command = {}
        self.buffer = b''
        self.drag = None
        self.pointer = None
        self.cell_pixels = None
        self.map = Minimap()
        self.names = False
        self.last_external = None
        self.leave = None
        self.interacted = False

    def frame_keys(self):
        keys=self.explicit_keys | self.first_frame_keys
        self.first_frame_keys.clear()
        return list(keys)

    def keyboard(self, char, phase):
        if not self.focused:return
        self.interacted = True
        if char in GAME_KEYS:
            if phase == 3:
                self.seen_release=True
                self.explicit_keys.discard(char)
            elif phase == 1 and self.seen_release:
                # A prior release confirms this stream actually forwards key-up.
                self.explicit_keys.add(char)
                self.first_frame_keys.add(char)
            elif char in self.explicit_keys:
                return
            elif char in CAMERA_STEPS:
                axis,delta=CAMERA_STEPS[char]
                self.command[axis]=self.command.get(axis,0)+delta
            else:
                self.first_frame_keys.add(char)
        elif phase != 3:
            if char == 'g' and phase != 2: self.command['dance'] = True
            if char in ('\r','\n'): self.command['nearest'] = True
            if char in ('=','+','-'): self.command['zoom'] = .12 if char!='-' else -.12
            if char == 'n': self.names = not self.names
            if char == 'h': self.command['home'] = True
            if char == '\x1b': self.command['cancel'] = True
            if char == 'm' and phase != 2: self.command['music'] = True
            if char == 'i' and phase != 2: self.leave = 'inventory'

    def read_input(self, w, h, cols, rows, hud_scale):
        self.map.resize(w, h, hud_scale)
        while select.select([0],[],[],0)[0]:
            packet = os.read(0,8192)
            if not packet: raise EOFError
            self.buffer += packet
        while self.buffer:
            buf = self.buffer
            if buf.startswith(ESC+b'_G'):
                end = buf.find(END)
                if end < 0: break
                self.buffer = buf[end+2:]; continue
            if match := CELL_SIZE.match(buf):
                height,width = map(int,match.group(1,2))
                if 0 < width <= 512 and 0 < height <= 512:
                    self.cell_pixels = (width,height)
                self.buffer=buf[match.end():];continue
            if buf.startswith((CSI+b'I',CSI+b'O')):
                self.focused = buf[2:3]==b'I'
                if not self.focused:
                    self.explicit_keys.clear();self.first_frame_keys.clear()
                    self.drag=None
                self.buffer=buf[3:];continue
            if match := MOUSE.match(buf):
                code,x,y = map(int,match.group(1,2,3))
                point = [(x-.5)*w/cols, (y-1.5)*h/(rows-2)]
                released = match[4]==b'm'
                if not released and code != 35:
                    self.interacted = True
                if code & 64:
                    self.command['zoom'] = self.command.get('zoom',0) + (.09 if code&1==0 else -.09)
                elif released:
                    self.drag=None
                elif code&3==2:
                    if self.drag is not None:
                        old_x,old_y=self.drag
                        self.command['orbit']=self.command.get('orbit',0)+(x-old_x)*.037
                        self.command['tilt']=self.command.get('tilt',0)+(old_y-y)*.06
                    self.drag=(x,y)
                elif code&32:
                    # Store a fraction of the presented image. A resolution step
                    # must not move the hover target while the mouse is still.
                    self.pointer=(-1.,-1.) if self.map.contains(point) else (point[0]/w,point[1]/h)
                elif code&3==0 and y==rows:
                    for label,kind in FOOTER_ACTIONS:
                        start=FOOTER_BUTTONS.index(label)+1
                        if start<=x<start+len(label):
                            self.action({'kind':kind})
                            break
                elif code&3==0 and 1<y<rows:
                    if self.map.contains(point):
                        self.command['walk']=self.map.destination(point)
                    else:
                        self.command['click']=point
                self.buffer=buf[match.end():];continue
            if match := KEY.match(buf):
                code=int(match[1]); phase=int(match[3] or b'0')
                if code<=0x10ffff:self.keyboard(chr(code).lower(),phase)
                self.buffer=buf[match.end():];continue
            if match := ARROW.match(buf):
                # Herdr emits CSI 1;1:1 A/B/C/D on every cursor press even
                # though it forwards no key-up. A press marker on an arrow
                # must only request one fallback frame of movement.
                phase=int(match[1] or b'0')
                self.keyboard(ARROWS[match[2]],0 if phase==1 else phase)
                self.buffer=buf[match.end():];continue
            if buf == ESC+b'O':break
            if buf.startswith(CSI):
                other=re.match(rb'\x1b\[[0-?]*[ -/]*[@-~]',buf)
                if other:self.buffer=buf[other.end():];continue
                if len(buf)<80:break
            self.keyboard(chr(buf[0]).lower(),0)
            self.buffer=buf[1:]

    def external(self, shared, initial=False):
        cmd=shared.get('runespace.worldCommand') or {}
        if cmd.get('id')==self.last_external:return
        self.last_external=cmd.get('id')
        if initial:return
        self.action(cmd)

    def action(self, cmd):
        kind=cmd.get('kind')
        if kind in ('walk','talk','orbit','tilt','home','dance','zoom','cancel','nearest','names','music','inventory'):
            self.interacted=True
        if kind=='walk':self.command['walk']=[cmd['x'],cmd['z']]
        if kind=='talk':self.command['talk']=cmd['key']
        if kind in ('orbit','tilt','zoom'):self.command[kind]=self.command.get(kind,0)+cmd['delta']
        if kind in ('home','dance','cancel','nearest','music'):self.command[kind]=True
        if kind=='names':self.names=not self.names
        if kind=='inventory':self.leave=kind
        if kind=='report':self.command['report']=True


def handoff(kind, frame, key=None):
    event={k:frame[k] for k in ('x','z','yaw','pitch','zoom') if k in frame}
    event.update(id=int(time.time()*1000),kind=kind)
    if key:event['key']=key
    atomic_json(EVENT,event)


class WalkBenchmark:
    """Time completed sends during real movement. Display timing is collected by Instruments."""
    phases = ('walk','orbit','walk_orbit')

    def __init__(self, identifier, now):
        self.identifier=identifier
        self.start=now
        self.started=False
        self.data={}
        self.phase=None
        self.last=None

    def prepare(self, now, request, keys, interrupted):
        elapsed=now-self.start
        if interrupted or elapsed>=26:
            request['benchmark']='restore'
            self.phase=None
            return False
        if not self.started:
            request['benchmark']='begin'
            self.started=True
        keys.clear()
        if elapsed < 2:
            return True
        self.phase=self.phases[min(2,int((elapsed-2)/8))]
        if self.phase != 'orbit':
            keys.append('right' if int(elapsed*.65)%2 else 'left')
        if self.phase != 'walk':
            keys.append('d')
        return True

    def sent(self, frame, sent_time, packet_size):
        if self.phase is None:
            return
        phase=self.data.setdefault(self.phase,{
            'sentTimes':[], 'firstEpoch':time.time(), 'minVisible':frame['visible'],
            'maximumRoster':0,'allInViewport':True,'walkDistance':0.,'orbitRadians':0.,
            'widthMin':frame['width'],'widthMax':frame['width'],'bytes':0})
        count=len(frame['agents'])
        phase['sentTimes'].append(sent_time)
        phase['minVisible']=min(phase['minVisible'],frame['visible'])
        phase['maximumRoster']=max(phase['maximumRoster'],count)
        phase['allInViewport'] &= frame['visible']==count
        phase['widthMin']=min(phase['widthMin'],frame['width'])
        phase['widthMax']=max(phase['widthMax'],frame['width'])
        phase['bytes']+=packet_size
        if self.last and self.last[0]==self.phase:
            phase['walkDistance']+=math.hypot(frame['x']-self.last[1],frame['z']-self.last[2])
            phase['orbitRadians']+=abs(frame['yaw']-self.last[3])
        self.last=self.phase,frame['x'],frame['z'],frame['yaw']

    def finish(self, interrupted):
        counts=[len(p['sentTimes']) for p in self.data.values()]
        atomic_json(DATA/'runespace-play-produced.json',dict(id=self.identifier,frames=sum(counts),
                    cancelled=interrupted, clock='time.monotonic after terminal write',
                    phases=self.data))


class RenderSize:
    # MTKView's mapped rows align to 64 RGBA pixels. Keep the highest-cost
    # readback/encode bounded on 5K displays, while rendering small panes 1:1.
    MAX_WIDTH = 1920
    MAX_HEIGHT = 1440

    def __init__(self):
        self.limit=1536
        self.since=None
        self.last_change=None
        self.frames=0
        self.busy=0.

    def dimensions(self, rows, cols, xp, yp, cell_pixels):
        if xp > 0 and yp > 0:
            pane_width=xp
            pane_height=yp*(rows-2)/rows
        else:
            # Herdr PTYs currently report zero pixel dimensions. The stock Guild
            # font's 14 pt grid measures 17x37 backing pixels on a Retina display.
            cell_width,cell_height=cell_pixels or (17,37)
            pane_width=cols*cell_width
            pane_height=(rows-2)*cell_height
        # Some emulators answer the cell query in logical points on Retina.
        # Keep a high-resolution sampling budget for that path; explicit backing
        # pixel dimensions from TIOCGWINSZ still cap the image at its native size.
        density=1. if xp and yp else max(1.,12.75/(pane_width/cols))
        scale=min(density,self.limit/pane_width,self.MAX_HEIGHT/pane_height)
        width=max(64,int(pane_width*scale)//64*64)
        height=max(1,min(self.MAX_HEIGHT,round(width*pane_height/pane_width)))
        return width,height

    def observe(self, start, finish, requested):
        if self.since is None:
            self.since=start
            self.last_change=start
        self.busy+=finish-start
        self.frames+=1
        elapsed=finish-self.since
        if elapsed<2:
            return
        cost=self.busy/self.frames
        fps=self.frames/elapsed
        previous=self.limit
        if fps<58.8 and cost>.014:
            # Lower the actual output even if the small viewport is below the cap.
            scale=min(.92,math.sqrt(.0125/cost))
            if requested>640:
                self.limit=max(640,int(requested*scale)//64*64)
        elif (fps>=59.3 and finish-self.last_change>=8 and
              requested>=self.limit-64 and self.limit<self.MAX_WIDTH):
            larger=min(self.MAX_WIDTH,self.limit+128)
            if cost*(larger/requested)**2<.012:
                self.limit=larger
        if self.limit!=previous:
            self.last_change=finish
        self.frames=0;self.busy=0.;self.since=finish


def render_loop(binary, directory):
    process=subprocess.Popen([binary,str(METAL),str(HOME),'terminal',str(directory)],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(directory/'renderer.log','ab'),bufsize=0)
    read=process.stdout.readline
    compressor=FrameCompressor()
    try:
        if json.loads(read()).get('type')!='ready':raise RuntimeError('Metal renderer could not start')
        controls=Controls()
        initial=read_json(HOME/'shared.json');controls.external(initial,True)
        focused_keys=FocusedGameKeys(DATA/'runespace-play/held-keys.json',initial.get('runespace.metalSince'))
        last_sync=0;deadline=time.monotonic();launched=deadline;index=0;frame={}
        bench=None;last_benchmark=None;last_hud=b'';last_save=0;saved=None
        quality=RenderSize();grid=None
        while process.poll() is None:
            now=time.monotonic()
            if now-last_sync>.25:
                shared=read_json(HOME/'shared.json');last_sync=now
                controls.external(shared)
                if shared.get('runespace.mode')!='play':
                    # A launch may spend its first second rebinding the terminal block.
                    if index or now-launched>8:break
                    time.sleep(.075);continue
                scenario=shared.get('runespace.playBenchmark') or {}
                if bench is None and scenario.get('id') and scenario.get('id')!=last_benchmark:
                    if 0 <= time.time()-scenario['id']/1000 < 4:
                        last_benchmark=scenario['id']
                        bench=WalkBenchmark(last_benchmark,now)
            rows,cols,xp,yp=screen_size()
            if grid!=(rows,cols,xp,yp):
                grid=(rows,cols,xp,yp)
                controls.cell_pixels=None
                if xp==0 or yp==0:
                    output(CSI+b'16t')  # Ask supporting terminals for cell height and width.
            width,height=quality.dimensions(rows,cols,xp,yp,controls.cell_pixels)
            hud_scale=width/(cols*5.75)
            controls.read_input(width,height,cols,rows,hud_scale)
            held=focused_keys.sample(time.time()*1000,controls.action)
            request=controls.command;controls.command={}
            report=request.pop('report',False)
            music=request.pop('music',False)
            if controls.pointer:request['pointer']=[controls.pointer[0]*width,controls.pointer[1]*height]
            keys=list(held.union(controls.frame_keys()))
            if held:controls.interacted=True
            finished=None
            if bench and not bench.prepare(now,request,keys,controls.interacted):
                finished=(bench,controls.interacted)
                bench=None
            controls.interacted=False
            request.update(type='frame',width=width,height=height,slot=index%3,keys=keys,names=controls.names,hudScale=hud_scale)
            process.stdin.write(json.dumps(request,separators=(',',':')).encode()+b'\n')
            line=read()
            if not line:raise RuntimeError('Metal renderer stopped')
            frame=json.loads(line)
            if frame.get('type')!='frame':raise RuntimeError(str(frame.get('error',frame.get('type'))))
            if frame.get('arrived') or controls.leave:
                handoff(controls.leave or 'chat',frame,frame.get('arrived'));break
            if music:
                handoff('music',frame)
            w,h=frame['width'],frame['height']
            raw=bytearray(w*h*4)
            with open(frame['path'],'rb') as pixels:
                if pixels.readinto(raw)!=len(raw):raise ValueError('Incomplete Metal frame')
            controls.map.resize(w,h,hud_scale)
            controls.map.compose(raw,frame,now)
            agents=frame.get('agents',[])
            selected=next((a for a in agents if a['key']==(frame.get('hovered') or frame.get('nearest'))),None)
            target=(selected.get('name') or selected['key']) if selected else ''
            title=safe_title('THE GUILD GREEN   ·   '+(target or f'{len(agents)} companions'),cols-1)
            footer=safe_title(FOOTER_BUTTONS+'   W/S tilt   A/D orbit   Arrows or click to walk   Scroll to zoom   Click companion to chat   N names   H commons',cols-1)
            hud=(CSI+b'1;1H'+CSI+b'2K'+CSI+b'1;33m'+title.encode()+CSI+b'0m'+f'\x1b[{rows};1H'.encode()+CSI+b'2K'+footer.encode())
            upload,placement=kitty_image(raw,w,h,cols,rows-2,index,compressor)
            output(upload+CSI+b'?2026h'+CSI+b'2;1H'+placement+(hud if hud!=last_hud else b'')+CSI+b'?2026l')
            sent_time=time.monotonic()
            quality.observe(now,sent_time,w)
            last_hud=hud
            if now-last_save>=2 and bench is None:
                last_save=now
                pose={k:frame[k] for k in ('x','z','yaw','pitch','zoom')}
                if pose!=saved:
                    atomic_json(DATA/'runespace-play-position.json',dict(pose,at=int(time.time()*1000)))
                    saved=pose
            if report and not music:
                player={'x':frame['x'],'z':frame['z'],'activity':frame.get('playerActivity','idle')}
                if frame.get('dancePhase') is not None:player['dancePhase']=frame['dancePhase']
                atomic_json(EVENT,dict(kind='report',id=int(time.time()*1000),report={**{k:frame[k] for k in ('yaw','pitch','zoom','width','height')},'player':player,'npcs':agents,'nearest':frame.get('nearest')}))
            if bench:
                bench.sent(frame,sent_time,len(upload))
            if finished:
                finished[0].finish(finished[1])
            index+=1
            deadline=max(deadline+1/RATE,time.monotonic()-.002)
            time.sleep(max(0,deadline-time.monotonic()))
    finally:
        compressor.close()
        process.stdin.close()
        try:process.wait(timeout=2)
        except subprocess.TimeoutExpired:process.terminate();process.wait()


def main():
    runtime=DATA/'runespace-play';runtime.mkdir(parents=True,exist_ok=True)
    old=termios.tcgetattr(0)
    def stop(_signum,_frame):raise SystemExit
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGHUP,stop)
    try:
        tty.setraw(0)
        # Request key phases and focus transitions. Some terminals only send presses.
        output(CSI+b'?1049h'+CSI+b'?25l'+CSI+b'?1003h'+CSI+b'?1006h'+CSI+b'?1004h'+CSI+b'>11u'+CSI+b'2J')
        with tempfile.TemporaryDirectory(prefix='frames-',dir=runtime) as name:
            render_loop(sys.argv[2],Path(name))
    except (EOFError,BrokenPipeError,SystemExit):pass
    except Exception as e:
        atomic_json(runtime/'error.json',{'at':time.time(),'error':str(e)})
        handoff('play-error',{})
    finally:
        delete_images=b''.join(ESC+f'_Ga=d,d=I,i={i},q=2;'.encode()+END for i in IMAGE_IDS)
        try:
            output(delete_images+CSI+b'<u'+CSI+b'?1004l'+CSI+b'?1006l'+CSI+b'?1003l'+CSI+b'?25h'+CSI+b'?1049l')
        finally:
            termios.tcsetattr(0,termios.TCSANOW,old)

if __name__=='__main__':main()
