import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'layout/mods/runespace/play'))
from guild_presence import GuildPresence


class PresenceTest(unittest.TestCase):
    def test_arrival_video_and_departure(self):
        with tempfile.TemporaryDirectory() as root:
            bridge=GuildPresence(root)
            bridge.directory.mkdir()
            tile=bytes.fromhex('ab19caff')*64
            (bridge.directory/'tile-guest.rgba').write_bytes(tile)
            peer={'id':'guest','name':'Alice','x':1,'z':2,'yaw':3,'moving':True}
            state={'updatedAt':time.time(),'status':'connected','self':'host','peers':[{},peer],
                   'tiles':[{'file':'tile-guest.rgba','video':True,'width':8,'height':8,'speaking':True}]}
            file=bridge.directory/'state.json'
            file.write_text(json.dumps(state))
            request={};bridge.read(request,1)
            self.assertEqual([p['id'] for p in request['teamPeers']],['guest'])
            self.assertEqual(request['teamSelf'],'host')
            image=bytearray(40*30*4);bridge.compose(image,40,30)
            self.assertEqual(image[(16*40+6)*4:(16*40+14)*4],tile[:32])
            self.assertEqual(image[(15*40+5)*4:(15*40+6)*4],bytes.fromhex('a2db78ff'))
            unchanged={};bridge.read(unchanged,1.2)
            self.assertEqual(unchanged,{})
            file.write_text(json.dumps({**state,'updatedAt':time.time()-12}))
            request={};bridge.read(request,1.4)
            self.assertEqual(request['teamPeers'],[])
            self.assertEqual(bridge.tiles,[])

    def test_pose_is_local_private_and_settles_when_leaving(self):
        with tempfile.TemporaryDirectory() as root:
            bridge=GuildPresence(root)
            frame={'teamPose':{'x':1,'z':2,'yaw':.5,'moving':True,'activity':'wood','loadout':{}},
                   'agents':[{'key':'local-session','name':'Private conversation','worldX':3,'worldZ':4,'yaw':1,'activity':'smith'}]}
            bridge.publish(frame,1)
            self.assertFalse(bridge.directory.exists())
            bridge.directory.mkdir()
            bridge.publish(frame,2)
            file=bridge.directory/'position.json'
            data=json.loads(file.read_bytes())
            self.assertEqual(data['agents'],[['local-session',3,4,1,'smith',False]])
            self.assertNotIn('Private conversation',file.read_text())
            self.assertEqual(file.stat().st_mode & 0o777,0o600)
            first=file.stat().st_mtime_ns
            bridge.publish(frame,3)
            self.assertEqual(file.stat().st_mtime_ns,first)
            bridge.publish(frame,3.01,leaving=True)
            data=json.loads(file.read_bytes())
            self.assertFalse(data['moving'])
            self.assertEqual(data['activity'],'idle')
            self.assertEqual(data['agents'],[])
            self.assertLess(abs(time.time()-data['sceneAt']),2)
