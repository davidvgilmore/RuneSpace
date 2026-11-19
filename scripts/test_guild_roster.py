import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import hmac
import hashlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'layout/mods/runespace/play'))
from guild_presence import GuildPresence


@unittest.skipUnless(sys.platform == 'darwin', 'The Herdr client uses macOS CryptoKit')
class LocalProjectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        build = Path(cls.temp.name)
        main = build/'main.swift'
        main.write_text("""
import Foundation
let args = CommandLine.arguments
let dir = URL(fileURLWithPath:args[1],isDirectory:true)
let r = try GuildRoster(directory:dir,snapshotKey:"runespace.snapshot",
    endpoint:URL(string:"https://guild.example/embedded-guild.html")!,invite:args[2],owner:args[3].isEmpty ? nil : args[3])
let pos = try JSONSerialization.jsonObject(with:Data(contentsOf:dir.appendingPathComponent("position.json"))) as? [String:Any]
let data:[String:Any] = ["projection":r.project(position:pos,sharing:args[4]=="on"),"contributor":r.contributorKey]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:data))
""")
        cls.binary = str(build/'project')
        subprocess.run(['/usr/bin/xcrun','swiftc',str(main),str(ROOT/'layout/mods/runespace/play/GuildRoster.swift'),
                        '-o',cls.binary],check=True)

    def test_only_opaque_ids_and_work_status_cross_the_webview(self):
        with tempfile.TemporaryDirectory() as temp:
            home=Path(temp)
            social=home/'data/runespace-social'
            social.mkdir(parents=True)
            raw='private/local/terminal'
            row={'key':raw,'name':'Private client thread','cwd':'/private/work','kind':'Pi','status':'working'}
            snapshot={'at':time.time(),'agents':[row,dict(row,key='offline',mapVisible=False)]}
            shared=home/'shared.json'
            shared.write_text(json.dumps({'runespace.snapshot':snapshot}))
            (social/'position.json').write_text(json.dumps({'agents':[[raw,1,2,3,'farm',False]],'privateData':'do not send'}))
            def get(invite='one',owner='',sharing='on'):
                return json.loads(subprocess.check_output([self.binary,str(social),invite,owner,sharing]))
            first=get()
            public=json.dumps(first)
            for secret in [raw,row['name'],row['cwd'],'privateData','offline']: self.assertNotIn(secret,public)
            one=first['projection']['roster']
            self.assertEqual(len(one),1)
            self.assertEqual(set(one[0]),{'id','kind','status'})
            self.assertEqual(one[0]['id'],first['projection']['agents'][0][0])
            self.assertEqual(json.loads((social/'agent-bindings.json').read_text()),{one[0]['id']:raw})
            self.assertEqual(get(),first)
            other=get(invite='two')
            self.assertNotEqual(other['projection']['roster'][0]['id'],one[0]['id'])
            self.assertNotEqual(other['contributor'],first['contributor'])
            owner='example owner for testing'
            self.assertEqual(get(owner=owner)['projection']['roster'][0]['id'],
                             hmac.new(owner.encode(), raw.encode(), hashlib.sha256).hexdigest())
            self.assertEqual(get(sharing='off')['projection']['roster'],[])
            self.assertEqual(json.loads((social/'agent-bindings.json').read_text()),{})
            snapshot['at']-=90
            shared.write_text(json.dumps({'runespace.snapshot':snapshot}))
            self.assertEqual(get()['projection']['roster'],[])


class StationTest(unittest.TestCase):
    def test_only_own_opaque_ids_resolve_to_private_chat_keys(self):
        with tempfile.TemporaryDirectory() as temp:
            b=GuildPresence(temp)
            b.directory.mkdir()
            pose=dict(x=1,z=2,yaw=.5,moving=False,activity='farm')
            foreign=dict(id='remote',ownerName='Guest',status='working',name='Pi druid 1',kind='Pi',**pose)
            state=dict(status='connected',updatedAt=time.time(),guildAgents=[foreign],
                       guildStations=[dict(id='mine',**pose),dict(id='forged',**pose)])
            (b.directory/'agent-bindings.json').write_text(json.dumps({'mine':'private chat key'}))
            path=b.directory/'state.json'
            path.write_text(json.dumps(state))
            request={};b.read(request,1)
            self.assertEqual(request['guildStations'],[dict(key='private chat key',**pose)])
            self.assertEqual(request['guildAgents'],[foreign])
            path.write_text(json.dumps(dict(state,status='stopped')))
            request={};b.read(request,2)
            self.assertEqual(request['guildStations'],[])
            self.assertEqual(request['guildAgents'],[])
