import fcntl
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PLAY = Path(__file__).resolve().parents[1] / 'layout/mods/runespace/play'
sys.path.insert(0, str(PLAY))
import social

LINK = 'https://guild.example:8465/#invite=example-long-enough-invite'
OWNER = 'private-owner-capability'


class GuildInviteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.data = self.home / 'data'
        self.data.mkdir()
        self.config = self.data / 'runespace-team.json'

    def test_guest_identity_and_explicit_preference(self):
        social.configure_guest(self.home, LINK+'&owner='+OWNER, '  Ada  ', False)
        self.assertEqual(json.loads(self.config.read_text()), {'url':LINK,'name':'Ada','shareAgents':False})
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        social.change_sharing(self.home, True)
        self.assertTrue(json.loads(self.config.read_text())['shareAgents'])
        social.change_sharing(self.home, False)
        self.assertFalse(json.loads(self.config.read_text())['shareAgents'])
        social.configure_guest(self.home, LINK, 'A second teammate', True)
        self.assertEqual(json.loads(self.config.read_text())['name'], 'A second teammate')
        self.assertEqual(social.invite(self.home), LINK)

    def test_host_configuration_survives_join_and_copy_actions(self):
        original=json.dumps({'url': LINK+'&owner='+OWNER,'name':'Host'})
        self.config.write_text(original)
        with self.assertRaisesRegex(RuntimeError, 'hosts'):
            social.configure_guest(self.home, LINK, 'Test', False)
        with self.assertRaisesRegex(ValueError, 'already hosts'):
            social.change_sharing(self.home, False)
        self.assertEqual(self.config.read_text(), original)
        self.assertEqual(social.invite(self.home), LINK)

    def test_explicit_visit_preserves_the_home_guild_and_uses_its_latest_configuration_on_return(self):
        base={'url':LINK+'&owner='+OWNER,'name':'Host','other':'keep'}
        self.config.write_text(json.dumps(base))
        guest=LINK.replace('guild.example:8465', 'away.example:8466')
        social.configure_guest(self.home,guest+'&owner=discard-this', 'Visitor', True,visit=True)
        visit=self.data/'runespace-visit.json'
        self.assertEqual(json.loads(visit.read_bytes()),{'url':guest,'name':'Visitor','shareAgents':True})
        self.assertEqual(json.loads(self.config.read_bytes()),base)
        self.assertEqual(social.invite(self.home),guest)
        social.change_sharing(self.home, False)
        self.assertFalse(json.loads(visit.read_bytes())['shareAgents'])
        self.assertEqual(json.loads(self.config.read_bytes()),base)
        active=visit.read_bytes()
        with self.assertRaises(ValueError):
            social.configure_guest(self.home,'not an invite','Visitor',False,visit=True)
        self.assertEqual(visit.read_bytes(),active)
        self.config.write_text(json.dumps({**base,'url':LINK.replace('guild.example','new.example')+'&owner='+OWNER}))
        visit.unlink()
        self.assertEqual(social.invite(self.home), LINK.replace('guild.example','new.example'))

    def test_invalid_import_preserves_existing_room(self):
        social.configure_guest(self.home, LINK, 'Ada', True)
        original=self.config.read_bytes()
        for link in [LINK.replace('https:', 'http:'), 'https://host/path#invite=0123456789abcdef', LINK.replace('guild.example','user@guild.example'),
                     LINK.replace('8465','oops'), 'https://host/#invite=short', LINK+'&invite=another', 'slack://room']:
            with self.subTest(link=link), self.assertRaises(ValueError):
                social.configure_guest(self.home, link, 'Teammate', False)
            self.assertEqual(self.config.read_bytes(),original)
        with self.assertRaisesRegex(ValueError, 'display name'):
            social.configure_guest(self.home, LINK,'a\nb',True)

    def test_invite_command_keeps_credentials_out_of_output(self):
        result=subprocess.run([sys.executable, str(PLAY/'social.py'),'join','--app-home',str(self.home),'--name=Ada','--invite-stdin'],
                              input='https://host/#owner='+OWNER, text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn(OWNER,result.stdout+result.stderr)
        self.assertFalse(self.config.exists())

    def test_active_call_rejects_switch_and_live_opt_out_queues_with_no_devices(self):
        folder=self.data/'runespace-social'
        folder.mkdir()
        social.configure_guest(self.home, LINK, 'Ada', True)
        with (folder/'instance.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            command=[sys.executable,str(PLAY/'social.py')]
            result=subprocess.run(command+['join','--app-home',str(self.home),'--invite-stdin','--name=Sam'],
                                  input=LINK, text=True,capture_output=True,timeout=5)
            self.assertIn('Leave the current call',result.stdout)
            result=subprocess.run(command+['share-off','--app-home',str(self.home)],text=True,capture_output=True,timeout=5,check=True)
        self.assertFalse(json.loads(result.stdout)['shareAgents'])
        self.assertEqual([json.loads(p.read_text()) for p in (folder/'commands').glob('*.json')],[{'kind':'share-off'}])
        self.assertEqual(json.loads(self.config.read_text()),{'url':LINK,'name':'Ada','shareAgents':False})


if __name__ == '__main__':
    unittest.main()
