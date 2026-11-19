import contextlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location('media_install', Path(__file__).with_name('install-media.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
HOST = 'demo.example.ts.net'
IP = '100.64.2.3'
VALID_ROUTE = {
    'TCP': {'8466': {'HTTPS': True}},
    'Web': {HOST + ':8466': {'Handlers': {'/': {'Proxy': installer.PROXY}}}},
}


class MediaHostTests(unittest.TestCase):
    def test_private_route_recognition(self):
        self.assertFalse(installer.route_exists({'TCP': {'443': {'HTTPS': True}}}, HOST, IP, '8466'))
        self.assertTrue(installer.route_exists(VALID_ROUTE, HOST, IP, '8466'))
        for bad in [
            {'TCP': {'8466': {'TCPForward': 'localhost:2222'}}},
            dict(VALID_ROUTE, AllowFunnel={HOST + ':8466': True}),
            dict(VALID_ROUTE, Web={HOST + ':8466': {'Handlers': {'/': {'Proxy': 'http://localhost:9999'}}}}),
            {'Foreground': {'another-session': VALID_ROUTE}},
        ]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                installer.route_exists(bad, HOST, IP, '8466')

    def test_turn_route_requires_tailnet_tls_and_expected_proxy(self):
        turn={'TCPForward':IP+':5349','TerminateTLS':HOST,'ProxyProtocol':2}
        config={'TCP':{'443':turn}}
        self.assertTrue(installer.route_exists(config,HOST,IP,'443'))
        self.assertFalse(installer.route_exists(VALID_ROUTE,HOST,IP,'443'))
        for bad in [dict(config, AllowFunnel={HOST+':443':True}), {'Foreground':{'other':config}},
                    {'TCP':{'443':dict(turn,ProxyProtocol=0)}},{'TCP':{'443':dict(turn,TCPForward='localhost:9999')}},
                    {'TCP':{'443':dict(turn,TerminateTLS='other.example.ts.net')}},{'TCP':{'443':{'HTTPS':True}}}]:
            with self.subTest(config=bad),self.assertRaises(ValueError):
                installer.route_exists(bad,HOST,IP,'443')

    def test_partial_install_adds_only_missing_turn_route(self):
        with mock.patch.object(installer,'routes',return_value={'8466':True,'443':False}),mock.patch.object(installer.subprocess,'run') as run:
            installer.configure_routes(HOST,IP)
            run.assert_called_once_with(['tailscale','serve','--bg','--yes','--proxy-protocol=2','--tls-terminated-tcp=443',
                                        'tcp://'+IP+':5349'],check=True)

    def test_secret_input(self):
        with tempfile.TemporaryDirectory() as folder:
            f = Path(folder) / 'keys'
            good = {'key': 'lab', 'secret': 'Z' * 32}
            f.write_text(json.dumps(good))
            f.chmod(0o644)
            with self.assertRaises(ValueError):
                installer.read_keys(str(f))
            f.chmod(0o600)
            self.assertEqual(installer.read_keys(str(f)), good)
            f.write_text(json.dumps(dict(good, invite='guild')))
            with self.assertRaises(ValueError):
                installer.read_keys(str(f))
            parsed = json.loads(installer.livekit_config(HOST, IP, good))
            self.assertEqual(parsed['keys'], {'lab': good['secret']})
            self.assertEqual(parsed['bind_addresses'], ['127.0.0.1'])
            self.assertEqual(parsed['rtc']['ips'], {'includes': [IP + '/32']})
            self.assertEqual(parsed['rtc']['tcp_port'], 0)
            self.assertEqual(parsed['rtc']['udp_port'],7882)
            turn=parsed['turn']
            self.assertEqual((turn['domain'],turn['tls_port'],turn['external_tls']), (HOST,5349,True))
            self.assertEqual(turn['bind_addresses'],[IP])
            self.assertEqual(turn['proxy_protocol_trusted_cidrs'],[IP+'/32'])
            self.assertTrue(turn['proxy_protocol'])
            self.assertEqual(turn['allow_restricted_peer_cidrs'],[IP+'/32'])


    def test_owned_sockets(self):
        tcp = 'tcp LISTEN 0 4096 127.0.0.1:7880 0.0.0.0:* users:(("livekit-server",pid=123,fd=7))'
        turn = tcp.replace('127.0.0.1:7880',IP+':5349')
        udp = f'udp UNCONN 0 0 {IP}:7882 0.0.0.0:* users:(("livekit-server",pid=123,fd=4))'
        with mock.patch.object(installer, 'pid', return_value='123'):
            with mock.patch.object(installer, 'output', return_value='\n'.join([tcp,turn,udp,udp.replace('7882','40021')])):
                installer.sockets(IP, True)
            for wrong in [udp.replace(IP, '0.0.0.0'), udp.replace('pid=123', 'pid=456'), turn.replace(IP,'0.0.0.0'), udp.replace('7882','41000')]:
                with mock.patch.object(installer, 'output', return_value='\n'.join([tcp,turn,udp,wrong])), self.assertRaises(ValueError):
                    installer.sockets(IP, True)

    def test_repeat_install_preserves_running_service(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.ExitStack() as stack:
            root = Path(folder)
            keys = root / 'keys'
            keys.write_text(json.dumps({'key': 'lab', 'secret': 'a' * 32}))
            keys.chmod(0o600)
            unit = root / 'runespace-media.service'
            config = root / 'config' / 'livekit.yaml'
            patch = lambda obj, key, **kw: stack.enter_context(mock.patch.object(obj, key, **kw))
            patch(installer, 'UNIT', new=unit)
            patch(installer, 'CONFIG', new=config)
            patch(installer.os, 'geteuid', return_value=0)
            patch(installer.platform, 'freedesktop_os_release', return_value={'ID': 'debian', 'VERSION_ID': '12'}, create=True)
            patch(installer.platform, 'machine', return_value='x86_64')
            patch(Path, 'is_dir', return_value=True)
            patch(installer, 'tailnet', return_value=(HOST, IP))
            patch(installer, 'routes', return_value={'8466':True, '443':True})
            patch(installer, 'sockets')
            patch(installer, 'health')
            patch(installer, 'check_turn_tls')
            patch(installer, 'install_binary', return_value=False)
            original_open = open
            stack.enter_context(mock.patch('builtins.open', side_effect=lambda file, *a, **kw:
                original_open(root / 'lock' if file == '/run/lock/runespace-media-install.lock' else file, *a, **kw)))
            run = patch(installer.subprocess, 'run')
            patch(sys, 'argv', new=['install-media.py', '--credentials', str(keys)])
            installer.main()
            self.assertIn(mock.call(['systemctl', 'restart', unit.name], check=True), run.call_args_list)
            run.reset_mock()
            installer.main()
            self.assertIn(mock.call(['systemctl', 'start', unit.name], check=True), run.call_args_list)
            self.assertNotIn(mock.call(['systemctl', 'restart', unit.name], check=True), run.call_args_list)


if __name__ == '__main__':
    unittest.main()
