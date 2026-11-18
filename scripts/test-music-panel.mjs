import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {TRACKS, clock, ALBUM_URL} from '../layout/mods/runespace-music/catalog.js';

// Exercise the view's event handlers with Herdr's filesystem/exec boundary stubbed.
// The native renderer is checked separately with herdr-app check.
const source = await readFile(new URL('../layout/mods/runespace-music/main.js', import.meta.url), 'utf8');
const code = source.replace(/^import .*;$/gm, '').replace('export default class GuildMusic', 'class GuildMusic') + '\nGuildMusic';

function harness(execCommand) {
  const tasks = [];
  const state = {requests: [], closed: [], focused: false, scrolled: [], files: 0};
  const snapshot = (track = 1, playing = true) => ({
    version: 2, running: true, phase: 'ready', track, playing, elapsed: 4, ok: true,
  });
  const cx = {
    notify() {}, stop_propagation() {},
    spawn(task) { tasks.push(task(cx)); },
    timer: {every(_ms, task) { state.tick = () => task(cx); }},
    focus_handle: () => ({focus() { state.focused = true; }}),
  };
  const View = vm.runInNewContext(code, {
    View: class {}, checking: () => false, appHome: () => '/isolated/home',
    props: () => ({overlay: 'guild-music-test'}), closeOverlay: id => state.closed.push(id),
    readTextFile: async () => { state.files++; return JSON.stringify(state.file); },
    ScrollHandle: {new: () => ({scroll_to_item: position => state.scrolled.push(position)})},
    TRACKS, clock, ALBUM_URL,
    exec: async (binary, args) => {
      assert.equal(binary, '/usr/bin/python3');
      assert.equal(args[0], '/isolated/home/mods/runespace/music/control.py');
      assert.deepEqual(Array.from(args.slice(2, 4)), ['--app-home', '/isolated/home']);
      state.requests.push(Array.from(args.slice(1)));
      const result = await execCommand(args[1], Number(args[5]) || null, snapshot);
      return {code: 0, stdout: JSON.stringify(result)};
    },
  });
  const view = new View();
  view.init({}, cx);
  const drain = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  return {view, state, cx, drain, snapshot};
}

test('the native list opens silently and keyboard selection targets the displayed track', async () => {
  const {view, state, cx, drain} = harness((action, track, snapshot) =>
    action === 'status' ? {ok: true, running: false} : snapshot(track));
  await drain();
  assert.equal(state.focused, true);
  assert.deepEqual(state.requests.map(r => r[0]), ['status']);
  state.tick();
  await drain();
  assert.equal(state.files, 0);
  const key = key => view.key({key, modifiers: {}}, cx);
  for (let i = 0; i < 8; i++) key('down');
  key('enter');
  await drain();
  assert.equal(TRACKS[8].title, 'Sea Shanty 2');
  assert.deepEqual(state.requests.at(-1).slice(-2), ['--track', '9']);
  assert.equal(view.track(), 9);
  key('m');
  assert.deepEqual(state.closed, ['guild-music-test']);
  assert.equal(state.requests.at(-1)[0], 'play');
});

test('a running soundtrack reopens at its actual song and follows automatic track changes', async () => {
  const {view, state, snapshot, cx, drain} = harness((_action, _track, snapshot) => snapshot(42));
  await drain();
  assert.equal(view.track(), 42);
  assert.equal(state.scrolled.at(-1), 41);
  state.file = snapshot(43);
  state.tick();
  await drain();
  assert.equal(view.track(), 43);
  assert.equal(state.scrolled.at(-1), 42);
  view.step(1, cx);
  await drain();
  assert.deepEqual(state.requests.at(-1).slice(-2), ['--track', '1']);
  view.toggle(cx);
  await drain();
  assert.equal(state.requests.at(-1)[0], 'pause');
});

test('quick track selections keep the last choice while the audio helper starts', async () => {
  let unblock;
  const {view, state, cx, drain} = harness(async (action, track, snapshot) => {
    if (action === 'status') return {ok: true, running: false};
    if (track === 2) await new Promise(resolve => { unblock = resolve; });
    return snapshot(track);
  });
  await drain();
  view.send('play', 2, cx);
  view.send('play', 3, cx);
  view.send('play', 4, cx);
  assert.equal(view.track(), 4);
  unblock();
  await drain();
  assert.deepEqual(state.requests.filter(r => r[0] === 'play').map(r => r.at(-1)), ['2', '4']);
  assert.equal(view.track(), 4);
});

test('browsing preserves an older music window until a listener explicitly stops or replaces it', async () => {
  const {view, state, cx, drain} = harness((action) => action === 'status'
    ? {ok: true, running: true, pid: 789} : {ok: true, version: 2, running: false});
  await drain();
  assert.equal(view.legacy, true);
  state.tick();
  await drain();
  assert.deepEqual(state.requests.map(r => r[0]), ['status']);
  view.toggle(cx);
  await drain();
  assert.equal(state.requests.at(-1)[0], 'stop');
  assert.equal(view.legacy, false);
});
