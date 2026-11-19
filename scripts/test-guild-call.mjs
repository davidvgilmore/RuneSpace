import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const dir = new URL('../layout/mods/runespace/', import.meta.url);
async function load(file, expression, mocks) {
  const js = (await readFile(new URL(file, dir), 'utf8'))
    .replace(/^import .*;$/gm, '').replace(/^export (default )?/gm, '');
  return vm.runInNewContext(js + '\n' + expression, mocks);
}

async function harness() {
  const tasks = [], requests = [], values = new Map();
  const cx = {notify() {}, spawn(task) { tasks.push(task(cx)); }};
  const world = {config: true, state: {}};
  const api = await load('guild-call.js', '({enterGuildCall,send,readState})', {
    View: class {}, checking: () => false, appHome: () => '/example',
    shared: key => values.get(key), setShared: (key, value) => values.set(key, value),
    readTextFile: async path => {
      if (path.endsWith('runespace-team.json')) {
        if (world.config) return '{"url":"https://example.invalid/#owner=private"}';
        throw Error('Room not configured');
      }
      return JSON.stringify(world.state);
    },
    exec: async (_python, args) => { requests.push([...args]); return {code: 0}; },
  });
  async function drain() { while (tasks.length) await Promise.all(tasks.splice(0)); }
  return {cx, world, api, values, requests, drain};
}

test('the local world still opens without a room and joins configured rooms with no device commands', async () => {
  const {cx, world, api, values, requests, drain} = await harness();
  const enter = () => api.enterGuildCall(cx, 'runespace');
  world.config = false;
  enter();
  await drain();
  assert.equal(requests.length, 0);
  world.config = true;
  enter();
  enter();
  await drain();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], ['/example/mods/runespace/play/social.py','start','--app-home','/example']);
  world.state = {connected: true, updatedAt: Date.now() / 1000, mic: true, peers: [{name:'Teammate'}]};
  enter();
  await drain();
  assert.equal(requests.length, 1, 'returning from an agent or inventory preserves the call');
  api.send(cx, 'runespace', 'stop');
  await drain();
  world.state = {};
  enter();
  await drain();
  assert.equal(requests.at(-1)[1], 'stop', 'an explicit leave survives returning to the world');
  api.send(cx, 'runespace', 'start');
  await drain();
  assert.equal(values.get('runespace.callPaused'), false);
  assert.equal(JSON.stringify([...values]).includes('private'), false);
});

test('a stale helper never leaves an active microphone or camera indicator', async () => {
  const {world, api} = await harness();
  world.state = {updatedAt: Date.now() / 1000 - 60, connected: true, mic: true, camera: true};
  assert.deepEqual({...await api.readState()}, {});
});

test('all desktop world shortcuts enter the same embedded world', async () => {
  const GuildHall = await load('main.js', 'GuildHall', {View: class {}});
  const view = new GuildHall(), visited = [];
  view.enterWorld = () => visited.push('world');
  for (const alias of ['world','team-guild','world-classic','world-embedded','world-window']) {
    view.command(alias, {});
  }
  assert.deepEqual(visited, Array(5).fill('world'));
});
