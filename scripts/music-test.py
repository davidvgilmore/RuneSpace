#!/usr/bin/env python3
"""Validate original scores and MIDI exports without playing sound."""
from pathlib import Path
import json, struct, unittest
ROOT=Path(__file__).resolve().parents[1]/'layout/mods/runespace/music'

def variable(data,index):
    value=0
    for _ in range(4):
        byte=data[index];index+=1;value=(value<<7)|(byte&127)
        if not byte&128:return value,index
    raise ValueError('Invalid variable length MIDI integer')

def validate_midi(path):
    data=path.read_bytes();assert data[:8]==b'MThd\0\0\0\x06'
    format_,count,ppq=struct.unpack('>HHH',data[8:14]);assert format_==1 and ppq==480
    offset=14;notes=0;last_ticks=[]
    for _ in range(count):
        assert data[offset:offset+4]==b'MTrk';length=struct.unpack('>I',data[offset+4:offset+8])[0]
        track=data[offset+8:offset+8+length];offset+=8+length;index=0;tick=0;active={};ended=False
        while index<len(track):
            delta,index=variable(track,index);tick+=delta;status=track[index];index+=1
            if status==255:
                kind=track[index];index+=1;n,index=variable(track,index);index+=n
                if kind==47:ended=True;break
            elif status&0xf0 in [0x80,0x90,0xb0]:
                pitch,velocity=track[index:index+2];index+=2
                if status&0xf0==0x90 and velocity:
                    active[pitch]=active.get(pitch,0)+1;notes+=1
                elif status&0xf0==0x80 or (status&0xf0==0x90 and not velocity):
                    assert active.get(pitch,0)>0,(path,pitch,tick);active[pitch]-=1
            elif status&0xf0==0xc0:index+=1
            else:raise ValueError('Unexpected MIDI status '+hex(status))
        assert ended and not any(active.values());last_ticks.append(tick)
    assert offset==len(data)
    return notes,last_ticks

class SoundtrackTests(unittest.TestCase):
    def test_three_complete_original_scores(self):
        manifest=json.loads((ROOT/'manifest.json').read_text());self.assertEqual(len(manifest['tracks']),3)
        for t in manifest['tracks']:
            score=json.loads((ROOT/(t['id']+'.score.json')).read_text())
            self.assertGreaterEqual(t['duration'],90);self.assertLessEqual(t['duration'],180)
            self.assertEqual(len(score['instruments']),6)
            self.assertGreater(len(score['notes']),800)
            self.assertTrue(all(n['beat']>=0 and 0<n['duration'] and 0<n['velocity']<128 and 0<=n['pitch']<=127 for n in score['notes']))
            self.assertTrue(all(n['beat']+n['duration']<=score['beats'] for n in score['notes']))
    def test_midis_have_balanced_notes_and_complete_tracks(self):
        for path in ROOT.glob('*.mid'):
            notes,ticks=validate_midi(path);score=json.loads(path.with_suffix('.score.json').read_text())
            self.assertEqual(notes,len(score['notes']));self.assertEqual(max(ticks),round(score['beats']*480))
    def test_playback_assets_are_substantial_aac_files(self):
        for t in json.loads((ROOT/'manifest.json').read_text())['tracks']:
            path=ROOT/t['audio'];self.assertGreater(path.stat().st_size,500_000)
            self.assertIn(b'ftypM4A',path.read_bytes()[:32])
if __name__=='__main__':unittest.main(verbosity=2)
