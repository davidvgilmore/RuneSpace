import json
from pathlib import Path
from tempfile import TemporaryDirectory
import sys
import unittest
from unittest.mock import patch

PLAY = Path(__file__).resolve().parents[1] / 'layout/mods/runespace/play'
with patch.object(sys, 'path', [str(PLAY), *sys.path]), patch.object(sys, 'argv', ['presenter', '.']):
    from presenter import Controls, FocusedGameKeys, WalkBenchmark


class CameraControlsTests(unittest.TestCase):
    def setUp(self):
        self.controls = Controls()

    def feed(self, packet):
        self.controls.buffer += packet
        with patch('select.select', return_value=([], [], [])):
            self.controls.read_input(768, 380, 152, 40, 1)

    def test_camera_keys_and_walking_keys_have_independent_releases(self):
        self.feed(b'\x1b[119;1:3u\x1b[119;1:1u\x1b[100;1:1u\x1b[1;1:1A')
        self.assertEqual(set(self.controls.frame_keys()), {'w', 'd', 'up'})
        self.feed(b'\x1b[1;1:2A\x1b[119;1:3u\x1b[1;1:')
        self.assertEqual(set(self.controls.frame_keys()), {'d', 'up'})
        self.feed(b'3A\x1b[100;1:3u')
        self.assertEqual(self.controls.frame_keys(), [])

    def test_legacy_and_modified_cursor_sequences_keep_wasd_for_camera(self):
        self.feed(b'wasd\x1bOA\x1b[B\x1b[1;2C\x1b[1;5:1D')
        self.assertEqual(set(self.controls.frame_keys()), {'up', 'down', 'left', 'right'})
        self.assertEqual(self.controls.command, {'orbit':0, 'tilt':0})

    def test_press_only_camera_applies_each_packet_once_without_coasting(self):
        # Even when the terminal advertises Kitty release support, Herdr can
        # send key-down bytes without ever delivering the matching key-up.
        self.feed(b'\x1b[?11u\x1b[119u\x1b[100;1u')
        self.assertAlmostEqual(self.controls.command.pop('tilt'),.028)
        self.assertAlmostEqual(self.controls.command.pop('orbit'),.035)
        self.assertEqual(self.controls.frame_keys(),[])
        self.feed(b'\x1b[119;1:2u\x1b[119;1:2u')
        self.assertAlmostEqual(self.controls.command.pop('tilt'),.056)
        for _ in range(10):
            self.assertEqual(self.controls.frame_keys(),[])
            self.assertEqual(self.controls.command,{})

    def test_herdr_kitty_arrow_press_marker_never_latches_after_a_tap(self):
        for suffix,char in [(b'A','up'),(b'B','down'),(b'C','right'),(b'D','left')]:
            packet=b'\x1b[1;1:1'+suffix
            for _ in range(2):
                self.feed(packet)
                self.assertEqual(self.controls.frame_keys(),[char])
                self.assertEqual(self.controls.frame_keys(),[])

    def test_focused_keys_track_transitions_heartbeat_stale_entry_and_quick_taps(self):
        with TemporaryDirectory() as tmp:
            path=Path(tmp)/'held-keys.json'
            reader=FocusedGameKeys(path,412)
            def put(seq,at,keys,counts,entry=412):
                new=path.with_suffix('.tmp')
                new.write_text(json.dumps(dict(entry=entry,seq=seq,at=at,keys=keys,presses=counts)))
                new.replace(path)
            put(0,1000,[],{})
            self.assertEqual(reader.sample(1000),set())
            put(1,1015,['up','w','left','d'],dict(up=1,w=1,left=1,d=1))
            self.assertEqual(reader.sample(1016),{'up','w','left','d'})
            self.assertEqual(reader.sample(1116),{'up','w','left','d'})
            put(2,1120,['up','d'],dict(up=1,w=1,left=1,d=1))
            self.assertEqual(reader.sample(1125),{'up','d'})
            put(4,1220,[],dict(up=1,w=2,left=1,d=1))
            self.assertEqual(reader.sample(1223),{'w'})
            self.assertEqual(reader.sample(1240),set())
            put(5,1250,['up'],dict(up=2,w=2,left=1,d=1))
            self.assertEqual(reader.sample(1260),{'up'})
            put(6,1460,['up'],dict(up=2,w=2,left=1,d=1))
            self.assertEqual(reader.sample(2090),{'up'})
            self.assertEqual(reader.sample(2120),set())
            put(7,2150,['left'],{},entry=132)
            self.assertEqual(reader.sample(2160),set())
            put(8,2170,['up'],{})
            self.assertEqual(reader.sample(2180),{'up'})
            path.unlink()
            self.assertEqual(reader.sample(2185),set())

    def test_focus_loss_discards_held_and_pending_keys(self):
        self.feed(b'\x1b[100;1:3u\x1b[100;1:1u\x1b[1;1:1A\x1b[Ows')
        self.assertEqual(self.controls.frame_keys(),[])
        self.assertEqual(self.controls.command,{})
        self.feed(b'\x1b[I\x1b[B')
        self.assertEqual(self.controls.frame_keys(),['down'])
        self.assertEqual(self.controls.frame_keys(),[])

    def test_focused_control_actions_keep_order_and_are_consumed_once(self):
        with TemporaryDirectory() as tmp:
            path=Path(tmp)/'held-keys.json';reader=FocusedGameKeys(path,1)
            actions=[dict(seq=1,at=500,kind='music'),dict(seq=2,at=2400,kind='names'),
                     dict(seq=3,at=2400,kind='zoom',delta=.12),dict(seq=4,at=2400,kind='zoom',delta=.12),
                     dict(seq=5,at=2400,kind='dance')]
            for seq in (1,2):
                path.write_text(json.dumps(dict(entry=1,seq=seq,at=2420,keys=[],actions=actions)))
                reader.sample(2420,self.controls.action)
            self.assertTrue(self.controls.names)
            self.assertIsNone(self.controls.leave)
            self.assertEqual(self.controls.command,{'zoom':.24,'dance':True})

    def test_wheel_zoom_and_ground_click_keep_their_commands(self):
        self.feed(b'\x1b[<64;12;15M\x1b[<64;12;15M\x1b[<0;12;15M')
        self.assertAlmostEqual(self.controls.command['zoom'], .18)
        self.assertEqual(self.controls.command['click'], [(12-.5)*768/152, (15-1.5)*380/38])
        self.assertEqual(self.controls.frame_keys(), [])

    def test_benchmark_walks_with_arrows_and_rotates_using_camera_keys(self):
        benchmark = WalkBenchmark(1,0)
        for elapsed, expected in [(3, ['right']), (11, ['d']), (19, ['left', 'd'])]:
            keys = []
            benchmark.prepare(elapsed,{},keys,False)
            self.assertEqual(keys,expected)

    def test_diagonal_drag_accumulates_both_axes_and_release_resets_anchor(self):
        self.feed(b'\x1b[<2;20;15M\x1b[<34;22;12M\x1b[<34;25;11M')
        self.assertAlmostEqual(self.controls.command['orbit'], 5 * .037)
        self.assertAlmostEqual(self.controls.command['tilt'], 4 * .06)
        self.controls.command.clear()
        self.feed(b'\x1b[<2;25;11m\x1b[<2;84;19M')
        self.assertEqual(self.controls.command, {})
        self.feed(b'\x1b[<34;84;21M')
        self.assertAlmostEqual(self.controls.command['tilt'], -2 * .06)
        self.assertEqual(self.controls.command['orbit'], 0)

    def test_shared_tilt_request_is_applied_once(self):
        request = {'runespace.worldCommand': {'kind': 'tilt', 'delta': .2, 'id': 7}}
        self.controls.external(request)
        self.assertEqual(self.controls.command, {'tilt': .2})
        self.controls.command.clear()
        self.controls.external(request)
        self.assertEqual(self.controls.command, {})

    def test_dance_key_and_footer_button_do_not_walk_or_repeat(self):
        self.feed(b'\x1b[103;1:1u')
        self.assertEqual(self.controls.command, {'dance': True})
        self.controls.command.clear()
        self.feed(b'\x1b[103;1:2u\x1b[103;1:3u\x1b[<0;10;40M')
        self.assertEqual(self.controls.command, {})
        self.assertIsNone(self.controls.leave)
        self.feed(b'\x1b[<0;4;40M\x1b[<0;4;40m')
        self.assertEqual(self.controls.command, {'dance': True})

    def test_inventory_key_footer_and_forwarded_action_use_the_same_handoff(self):
        self.feed(b'\x1b[105;1:2u\x1b[105;1:3u')
        self.assertIsNone(self.controls.leave)
        self.feed(b'\x1b[105;1:1u')
        self.assertEqual(self.controls.leave,'inventory')
        self.controls.leave=None
        self.feed(b'\x1b[<0;13;40M\x1b[<0;13;40m')
        self.assertEqual(self.controls.leave,'inventory')
        self.assertEqual(self.controls.command,{})
        self.controls.leave=None
        self.controls.action({'kind':'inventory'})
        self.assertEqual(self.controls.leave,'inventory')
