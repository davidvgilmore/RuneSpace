#!/usr/bin/env python3
"""Original medieval game scores. Standard-library MIDI writer; no copied melodies."""
from pathlib import Path
import json, math, struct
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'layout/mods/runespace/music'
OUT.mkdir(parents=True,exist_ok=True)
PPQ=480

def vlq(n):
    out=[n&127];n>>=7
    while n:out.insert(0,(n&127)|128);n>>=7
    return bytes(out)
def chunk(kind,data):return kind+struct.pack('>I',len(data))+data

def midi(score,path):
    tempo=round(60_000_000/score['bpm'])
    signature=score.get('signature',[4,4]);denom=int(math.log2(signature[1]))
    conductor=b'\x00\xff\x51\x03'+tempo.to_bytes(3,'big')+b'\x00\xff\x58\x04'+bytes([signature[0],denom,24,8])+b'\x00\xff\x2f\x00'
    tracks=[chunk(b'MTrk',conductor)]
    for channel,inst in enumerate(score['instruments']):
        name=inst['name'].encode();events=[(0,b'\xff\x03'+vlq(len(name))+name),(0,bytes([0xC0|channel,inst['program']])),(0,bytes([0xB0|channel,10,inst['pan']])),(0,bytes([0xB0|channel,7,100]))]
        for n in score['notes']:
            if n['instrument']!=channel:continue
            events.extend([(round(n['beat']*PPQ),bytes([0x90|channel,n['pitch'],n['velocity']])),(round((n['beat']+n['duration'])*PPQ),bytes([0x80|channel,n['pitch'],0]))])
        events.sort(key=lambda e:(e[0],e[1][0]&0xf0!=0x80));data=bytearray();previous=0
        for tick,event in events:data.extend(vlq(tick-previous)+event);previous=tick
        data.extend(vlq(max(0,round(score['beats']*PPQ)-previous))+b'\xff\x2f\x00');tracks.append(chunk(b'MTrk',bytes(data)))
    path.write_bytes(chunk(b'MThd',struct.pack('>HHH',1,len(tracks),PPQ))+b''.join(tracks))

class Score:
    def __init__(self,ident,title,bpm,bar,signature,mood):
        self.data=dict(id=ident,title=title,bpm=bpm,barBeats=bar,signature=signature,mood=mood,instruments=[],notes=[])
    def instrument(self,name,program,pan):
        self.data['instruments'].append(dict(name=name,program=program,pan=pan));return len(self.data['instruments'])-1
    def note(self,inst,beat,pitch,duration,velocity=64):
        if pitch is not None:self.data['notes'].append(dict(instrument=inst,beat=round(beat,5),pitch=pitch,duration=round(duration,5),velocity=max(1,min(120,velocity))))
    def phrase(self,inst,start,phrase,velocity=72,transpose=0):
        for i,(pitch,duration) in enumerate(phrase):
            self.note(inst,start,None if pitch is None else pitch+transpose,duration*.94,velocity+(i%3-1)*3);start+=duration
    def finish(self,bars):
        self.data['beats']=bars*self.data['barBeats'];self.data['duration']=round(self.data['beats']*60/self.data['bpm']+2.2,2)
        for n in self.data['notes']:n['duration']=round(min(n['duration'],self.data['beats']-n['beat']),5)
        (OUT/(self.data['id']+'.score.json')).write_text(json.dumps(self.data,separators=(',',':'))+'\n')
        midi(self.data,OUT/(self.data['id']+'.mid'));return self.data

# D Dorian in lilting 6/8, a quiet courtly air with an answering oboe.
s=Score('lanterns','Lanterns at the Commons',72,3,[6,8],'Romantic · flute, harp & warm strings')
flute=s.instrument('Wooden flute',73,72);harp=s.instrument('Celtic harp',46,42);lute=s.instrument('Lute (nylon guitar)',24,84);strings=s.instrument('Warm strings',48,61);oboe=s.instrument('Oboe answer',68,53);bass=s.instrument('Bassoon',70,64)
chords=[[50,57,62,65],[53,57,60,65],[48,55,60,64],[55,59,62,67],[50,57,62,65],[52,55,59,64],[48,55,60,64],[50,57,62,65]]
a=[[(74,.5),(69,.5),(74,1),(77,.5),(76,.5)],[(77,.75),(81,.25),(79,.5),(77,.5),(76,.5),(74,.5)],[(72,1),(76,.5),(79,.5),(76,.5),(74,.5)],[(76,.5),(79,.5),(81,1),(79,.5),(76,.5)],[(74,.5),(77,.5),(81,.75),(79,.25),(77,.5),(76,.5)],[(71,.5),(74,.5),(76,1),(77,.5),(76,.5)],[(72,1),(69,.5),(72,.5),(74,.5),(76,.5)],[(74,2.5),(None,.5)]]
b=[[(81,1),(79,.5),(77,.5),(76,.5),(74,.5)],[(77,.5),(79,.5),(81,1.5),(77,.5)],[(79,.75),(76,.25),(72,1),(74,.5),(76,.5)],[(79,1),(83,.5),(81,.5),(79,1)],[(81,.5),(86,.5),(84,.5),(81,.5),(77,.5),(74,.5)],[(76,.5),(79,.5),(83,1),(81,.5),(79,.5)],[(76,1),(74,.5),(72,.5),(69,.5),(72,.5)],[(74,2),(69,.5),(None,.5)]]
for bar in range(48):
    start=bar*3;ch=chords[(bar-4)%8] if bar>=4 else chords[bar%4]
    for k,p in enumerate([ch[0]+12,ch[2],ch[3],ch[1]+12,ch[2],ch[3]]):s.note(harp,start+k*.5,p,.73,48+(k%3==0)*6)
    if bar%2==0:s.note(bass,start,ch[0]-12,5.75,39)
    for p in ch[1:]:s.note(strings,start+.03,p,2.94,28+(4 if 20<=bar<36 else 0))
    for k in [0,1.5]:
        for j,p in enumerate(ch[1:]):s.note(lute,start+k+j*.026,p,.9,35+j*2)
    if 4<=bar<44:
        phrase=(b if 20<=bar<36 else a)[(bar-4)%8];s.phrase(flute,start,phrase,73 if bar<36 else 76)
        if 28<=bar<36 or 40<=bar<44:s.phrase(oboe,start,[(ch[2],1.5),(ch[3],1.5)],45)
    if bar==44:s.phrase(flute,start,[(77,1),(76,.5),(74,1.5)],67)
    if bar==45:s.phrase(flute,start,[(72,1.5),(69,1.5)],62)
    if bar==46:s.phrase(flute,start,[(74,3)],61)
lanterns=s.finish(48)

# A broad D-minor procession: horn calls, bowed ostinato, flute countermelody.
s=Score('banners','Banners at Dawn',108,4,[4,4],'Epic · horns, strings & bright harp')
horn=s.instrument('French horn',60,61);strings=s.instrument('Bowed strings',48,47);harp=s.instrument('Harp',46,80);flute=s.instrument('Piccolo-flute answer',73,75);low=s.instrument('Low strings',42,58);bell=s.instrument('Tubular bells',14,70)
chords=[[50,57,62,65],[46,53,58,62],[53,60,65,69],[48,55,60,64],[50,57,62,65],[55,62,67,70],[46,53,58,62],[45,52,57,61]]
a=[[(62,1.5),(69,.5),(67,.5),(65,.5),(62,1)],[(65,1),(62,.5),(65,.5),(70,1.5),(69,.5)],[(69,1.5),(72,.5),(69,1),(65,1)],[(67,.75),(64,.25),(60,1),(64,1),(67,1)],[(69,1),(74,1),(72,.5),(69,.5),(65,1)],[(67,1),(70,1),(74,1.5),(72,.5)],[(70,1),(69,.5),(65,.5),(62,2)],[(64,1),(61,1),(57,1),(None,1)]]
b=[[(74,1.5),(77,.5),(76,1),(74,1)],[(74,.75),(70,.25),(65,1),(70,1),(74,1)],[(72,1),(69,1),(65,.5),(69,.5),(72,1)],[(76,1.5),(74,.5),(72,1),(67,1)],[(77,.5),(76,.5),(74,1),(69,1),(74,1)],[(79,1),(77,.5),(74,.5),(70,2)],[(74,1),(70,.5),(69,.5),(65,1),(62,1)],[(64,1.5),(61,.5),(69,1),(None,1)]]
for bar in range(56):
    start=bar*4;ch=chords[(bar-4)%8] if bar>=4 else chords[bar%4]
    for k,p in enumerate([ch[0],ch[2],ch[1],ch[2],ch[0],ch[3],ch[1],ch[2]]):s.note(strings,start+k*.5,p,.43,49+(k%4==0)*10)
    s.note(low,start,ch[0]-12,3.85,52)
    for k,p in enumerate([ch[0]+12,ch[1]+12,ch[2]+12,ch[3]+12]):s.note(harp,start+k,p,1.35,48)
    if bar%8==4:s.note(bell,start,ch[0]+24,3.2,43)
    if 4<=bar<52:
        phrase=(b if 20<=bar<36 else a)[(bar-4)%8];s.phrase(horn,start,phrase,77 if 20<=bar<36 else 72)
        if bar>=12 and bar%8>=4:s.phrase(flute,start,[(ch[3]+12,1),(ch[2]+12,1),(ch[1]+12,1),(ch[2]+12,1)],52)
    if bar==52:s.phrase(horn,start,[(69,1),(74,2),(72,1)],70)
    if bar==53:s.phrase(horn,start,[(70,1),(69,1),(65,2)],66)
    if bar==54:s.phrase(horn,start,[(62,4)],62)
banners=s.finish(56)

# G Mixolydian strolling tune, plucked dance pulse and flute/recorder interplay.
s=Score('willow','The Willow Road',96,4,[4,4],'Pastoral · flute, lute & dancing harp')
flute=s.instrument('Flute',73,69);recorder=s.instrument('Recorder',74,48);lute=s.instrument('Lute (nylon guitar)',24,79);harp=s.instrument('Harp',46,38);strings=s.instrument('Soft strings',48,60);bass=s.instrument('Bassoon',70,64)
chords=[[43,50,55,59],[41,48,53,57],[48,55,60,64],[43,50,55,59],[45,52,57,60],[48,55,60,64],[41,48,53,57],[43,50,55,59]]
a=[[(79,.5),(74,.5),(71,1),(74,.5),(76,.5),(79,1)],[(77,1),(76,.5),(72,.5),(69,1),(72,1)],[(76,.5),(79,.5),(84,1),(83,.5),(79,.5),(76,1)],[(74,1.5),(71,.5),(67,1),(None,1)],[(69,.5),(72,.5),(76,1),(79,1),(76,.5),(72,.5)],[(72,.5),(76,.5),(79,.5),(76,.5),(74,1),(72,1)],[(69,1),(72,1),(77,.5),(76,.5),(72,1)],[(71,1),(74,1),(79,1.5),(None,.5)]]
b=[[(83,1),(81,.5),(79,.5),(74,1),(79,1)],[(81,.5),(77,.5),(76,.5),(72,.5),(77,1.5),(None,.5)],[(84,1),(83,.5),(79,.5),(76,1),(79,1)],[(83,.5),(81,.5),(79,1),(74,1),(71,1)],[(81,1),(79,.5),(76,.5),(72,1),(69,1)],[(76,.5),(79,.5),(84,1.5),(83,.5),(79,1)],[(77,.75),(76,.25),(72,1),(69,1),(72,1)],[(74,1),(71,1),(67,1.5),(None,.5)]]
for bar in range(48):
    start=bar*4;ch=chords[(bar-4)%8] if bar>=4 else chords[bar%4]
    for k,p in enumerate([ch[0]+12,ch[2],ch[1]+12,ch[3],ch[0]+12,ch[2],ch[1]+12,ch[3]]):s.note(lute,start+k*.5,p,.55,51+(k%4==0)*7)
    for k,p in enumerate([ch[2]+12,ch[3]+12,ch[1]+24,ch[3]+12]):s.note(harp,start+k+.03,p,.95,42)
    s.note(bass,start,ch[0],1.75,43);s.note(bass,start+2,ch[1],1.75,38)
    for p in ch[1:]:s.note(strings,start,p,3.9,25)
    if 4<=bar<44:
        phrase=(b if 20<=bar<36 else a)[(bar-4)%8];s.phrase(flute,start,phrase,73)
        if 28<=bar<36:s.phrase(recorder,start+2,[(ch[2]+12,1),(ch[3]+12,1)],48)
    if bar==44:s.phrase(flute,start,[(79,1),(76,1),(74,2)],66)
    if bar==45:s.phrase(flute,start,[(72,1),(71,1),(67,2)],62)
    if bar==46:s.phrase(flute,start,[(79,4)],57)
willow=s.finish(48)
tracks=[lanterns,banners,willow]
manifest={'version':1,'title':'Songs of the Guild','credit':'Original compositions for RuneSpace.','tracks':[{k:t[k] for k in ['id','title','duration','bpm','mood']}|{'audio':t['id']+'.m4a','midi':t['id']+'.mid'} for t in tracks]}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
for t in tracks:print(t['id'],t['duration'],'seconds',len(t['notes']),'notes')
