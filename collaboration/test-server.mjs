import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { WebSocket } from 'ws';
import { TokenVerifier } from 'livekit-server-sdk';
import { createRoomServer, settings } from './server.mjs';

const invitation = 'test-only-room-invitation';
async function fixture(t, options = {}) {
  const room = createRoomServer({ port: 0, invite: invitation, ...options });
  const { origin, inviteLink } = await room.listen();
  t.after(() => room.close());
  assert.equal(new URL(inviteLink).hash, '#invite=' + invitation);
  const post = (path, value, session, requestOrigin = origin) => fetch(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: requestOrigin, ...(session && { Authorization: 'Bearer ' + session }) },
    body: JSON.stringify(value)
  });
  async function join(name) {
    const res = await post('/api/join', { name, invite: invitation });
    assert.equal(res.status, 201);
    return res.json();
  }
  function socket() { return new WebSocket(origin.replace('http', 'ws') + '/presence', { origin }); }
  async function connect(session) {
    const ws = socket();
    let latest;
    ws.on('message', data => { latest = JSON.parse(data); });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', session }));
    const state = async predicate => {
      const signal = AbortSignal.timeout(4000);
      while (!latest || !predicate(latest)) await once(ws, 'message', { signal });
      return latest;
    };
    await state(s => s.type === 'world');
    return { ws, state };
  }
  return { origin, post, join, socket, connect };
}

test('invites, origin checks and asset allowlist keep credentials scoped to the room', async t => {
  const { origin, post, join, socket } = await fixture(t);
  const joined = await join('Ranger');
  assert.equal(joined.media, false);
  assert.equal((await post('/api/join', { name: 'No', invite: 'wrong' })).status, 403);
  assert.equal((await post('/api/join', { name: 'No', invite: invitation }, null, 'https://other.test')).status, 403);
  assert.equal((await post('/api/join', { name: '\nNo', invite: invitation })).status, 400);
  assert.equal((await post('/api/media', {}, joined.id)).status, 401);
  assert.equal((await post('/api/media', {}, joined.session)).status, 503);
  assert.equal((await fetch(origin + '/server.mjs')).status, 404);
  assert.equal((await fetch(origin + '/vendor/livekit-client.umd.min.js')).status, 200);
  assert.equal((await fetch(origin + '/world/world-engine.js')).status, 200);
  const unauthorized = socket();
  await once(unauthorized, 'open');
  const closing = once(unauthorized, 'close');
  unauthorized.send(JSON.stringify({ type: 'hello', session: joined.id }));
  assert.equal((await closing)[0], 1008);
  const foreign = new WebSocket(origin.replace('http', 'ws') + '/presence', { origin: 'https://elsewhere.test' });
  const [error] = await once(foreign, 'error');
  assert.match(error.message, /403/);
});

test('two remote players share only connected peers, receive bounded movement, resume and leave', async t => {
  const { post, join, connect } = await fixture(t);
  const a = await join('Mage'), b = await join('Ranger');
  const first = await connect(a.session), second = await connect(b.session);
  const initial = await first.state(s => s.peers.length === 2);
  assert.equal(initial.self, a.id);
  assert.deepEqual(initial.agents, []);
  assert.deepEqual(new Set(initial.peers.map(p => p.id)), new Set([a.id, b.id]));
  for (const p of initial.peers) assert.deepEqual(Object.keys(p).sort(), ['id','name','seq','x','yaw','z']);
  const start = initial.peers.find(p => p.id === a.id);
  first.ws.send(JSON.stringify({ type: 'move', id: b.id, x: start.x+100, z: start.z, yaw: 8, seq: 1 }));
  const updated = (await second.state(s => s.peers.some(p => p.id === a.id && p.seq === 1))).peers;
  const moved = updated.find(p => p.id === a.id);
  assert.ok(moved.x > start.x && moved.x <= start.x+1.601);
  assert.ok(Math.abs(moved.yaw) <= Math.PI);
  assert.deepEqual(updated.find(p => p.id === b.id), initial.peers.find(p => p.id === b.id));
  first.ws.terminate();
  await second.state(s => s.peers.length === 1);
  const resumed = await connect(a.session);
  const rejoined = await resumed.state(s => s.peers.length === 2);
  assert.deepEqual(rejoined.peers.find(p => p.id === a.id), moved);
  assert.equal((await post('/api/leave', {}, a.session)).status, 200);
  await second.state(s => s.peers.length === 1);
  assert.equal((await post('/api/media', {}, a.session)).status, 401);
});

test('a duplicated tab resumes one identity and tells its old connection to stop retrying', async t => {
  const { join, connect } = await fixture(t);
  const player = await join('Knight');
  const original = await connect(player.session);
  const oldClosed = once(original.ws,'close');
  const replacement = await connect(player.session);
  assert.equal((await oldClosed)[0], 4001);
  const snapshot = await replacement.state(s => s.peers.length === 1);
  assert.equal(snapshot.peers[0].id, player.id);
});

test('media credentials bind a generated identity to one room, microphone and camera', async t => {
  const livekit = { url: 'wss://media.example.test', apiKey: 'example', apiSecret: randomBytes(32).toString('hex') };
  const { post, join, connect } = await fixture(t, { livekit });
  const a = await join('Mage'), b = await join('Ranger');
  assert.equal(a.media, true);
  assert.equal((await post('/api/media', {}, a.session)).status, 409);
  await connect(a.session); await connect(b.session);
  const verify = new TokenVerifier(livekit.apiKey, livekit.apiSecret);
  const tokens = [];
  for (const person of [a,b]) {
    const res = await post('/api/media', { identity: 'impostor', room: 'other-room' }, person.session);
    assert.equal(res.status, 200);
    const { url, token } = await res.json();
    assert.equal(url, livekit.url);
    const claims = await verify.verify(token);
    assert.equal(claims.sub, person.id);
    assert.equal(claims.video.roomJoin, true);
    assert.match(claims.video.room, /^runespace-/);
    assert.equal(claims.video.canPublishData, false);
    assert.deepEqual(claims.video.canPublishSources, ['camera','microphone']);
    assert.equal(claims.video.roomAdmin, undefined);
    tokens.push(claims);
  }
  assert.equal(tokens[0].video.room, tokens[1].video.room);
});

test('expired reservations cannot join media or re-enter with the old credential', async t => {
  const { post, join, socket } = await fixture(t, { resumeMs: 25 });
  const player = await join('Knight');
  await new Promise(ok => setTimeout(ok, 40));
  const ws = socket();
  await once(ws,'open');
  const closed = once(ws,'close');
  ws.send(JSON.stringify({ type:'hello', session:player.session }));
  assert.equal((await closed)[0],1008);
  assert.equal((await post('/api/leave',{},player.session)).status,401);
});

test('partial media configuration and unspecified remote origins fail visibly', () => {
  assert.throws(() => settings({ LIVEKIT_URL: 'wss://media.test' }), /together/);
  assert.throws(() => createRoomServer({ host: '0.0.0.0' }), /ORIGIN/);
  assert.throws(() => createRoomServer({ origin:'https://room.test', livekit:{url:'ws://media.test'} }), /wss:/);
});
