import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, createHmac, createHash } from 'node:crypto';
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

test('only the owner opens a current desktop target and receives its private display title', async t => {
  const {mkdtemp, rm, writeFile} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'guild-host-test-'));
  t.after(() => rm(folder, {recursive:true, force:true}));
  const file = join(folder, 'shared.json');
  const privateKey = 'm4:private-conversation-123';
  const src = {kind:'Codex', status:'working', key:privateKey, name:'Review the maze', cwd:'/secret/project'};
  const roster = {'guild.snapshot':{at:Date.now()/1000, agents:[src,
    {...src,key:'another-private-session',name:'Fix /secret/project'},
    {...src,key:'private-key-2',name:'Review private-key-2'}]},
    'runespace.snapshot':{at:Date.now()/1000, agents:[{...src, key:'wrong-layout'}]}};
  await writeFile(file, JSON.stringify(roster));
  const token = randomBytes(32).toString('hex');
  const calls = [];
  const desktop = {token, cli:'/app/herdr-app', mod:'guild-hall', run:async (cli,args) => {
    calls.push({cli,args});
    return {stdout:JSON.stringify(args[0] === 'status' ? {layout:'guild-hall'} : {ok:true})};
  }};
  const {post, connect, origin} = await fixture(t, {desktop, agentRoster:file});
  const login = async owner => (await post('/api/join', {name:'Adventurer',invite:invitation,owner})).json();
  const guest = await login(invitation), owner = await login(token);
  assert.equal(guest.canOpenChats, false);
  assert.equal(guest.canOpenWorld, false);
  assert.equal(owner.canOpenChats, true);
  assert.equal(owner.canOpenWorld, true);
  assert.equal((await post('/api/herdr-world', {}, owner.session)).status,409);
  const guestConnection = await connect(guest.session), ownerConnection = await connect(owner.session);
  const [g,o] = await Promise.all([guestConnection.state(s=>s.agents.length),ownerConnection.state(s=>s.agents.length)]);
  assert.ok(g.agents.every(a=>Object.keys(a).sort().join() === 'hostAgent,id,kind,name,ownerId,ownerName,status'));
  const titled = o.agents.filter(a=>a.chatTitle);
  assert.equal(titled.length, 1);
  assert.equal(titled[0].chatTitle, 'Review the maze');
  for (const s of [g,o]) {
    for (const raw of [privateKey,'another-private-session','private-key-2','/secret','wrong-layout']) assert.ok(!JSON.stringify(s).includes(raw));
  }
  const id = titled[0].id;
  const chat = (s,target=id) => post('/api/agent-chat', {id:target}, s);
  assert.equal((await post('/api/herdr-world',{},guest.session)).status,403);
  assert.equal((await chat(guest.session)).status,403);
  assert.equal((await chat(owner.session,privateKey)).status,404);
  assert.equal((await fetch(origin+'/api/herdr-world',{method:'POST',headers:{Authorization:'Bearer '+owner.session,Origin:'https://other.example'}})).status,403);
  assert.equal(calls.length,0);
  assert.equal((await chat(owner.session)).status,200);
  assert.equal((await post('/api/herdr-world',{},owner.session)).status,200);
  assert.deepEqual(calls.filter(c=>c.args[0]==='do').map(c=>c.args),[
    ['do', 'guild-hall.select:'+privateKey], ['do','guild-hall.world']]);
  if (process.platform === 'darwin') assert.equal(calls.filter(c=>c.cli==='/usr/bin/open').length,2);
  delete roster['guild.snapshot'];
  await writeFile(file, JSON.stringify(roster));
  assert.equal((await chat(owner.session)).status,404);
  assert.equal((await post('/api/leave',{},owner.session)).status,200);
  assert.equal((await post('/api/herdr-world',{},owner.session)).status,401);
});

test('host capability configuration requires a distinct owner secret and an absolute Herdr CLI path', () => {
  const token=randomBytes(32).toString('hex');
  const desktop={token,cli:'/app/herdr-app',mod:'runespace'};
  assert.throws(()=>createRoomServer({invite:token,desktop}), /separate random/);
  assert.throws(()=>createRoomServer({desktop:{...desktop,cli:'untrusted'}}), /absolute/);
  assert.throws(()=>createRoomServer({desktop:{...desktop,mod:'arbitrary-command'}}), /HERDR_MOD/);
});

test('guildmates see woodcutting, combat and approved equipment when the player stands still', async t => {
  const {join, connect} = await fixture(t);
  const player = await join('Mage'), friend = await join('Ranger');
  const a = await connect(player.session), b = await connect(friend.session);
  const first = await a.state(s => s.peers.length === 2);
  const avatar = first.peers.find(peer => peer.id === player.id);
  function move(seq, activity, loadout) {
    a.ws.send(JSON.stringify({type:'move', x:avatar.x, z:avatar.z, yaw:0, seq, activity, loadout}));
    return b.state(s => s.peers.some(p => p.id === player.id && p.seq === seq))
      .then(s => s.peers.find(p => p.id === player.id));
  }
  assert.equal((await move(1, 'wood')).activity, 'wood');
  const combat = await move(2, 'attack', {weapon:'armadyl-godsword',shield:'dragonfire-shield',extra:'untrusted'});
  assert.equal(combat.activity, 'attack');
  assert.equal(combat.loadout.weapon, 'armadyl-godsword');
  assert.equal(combat.loadout.shield, 'none');
  assert.ok(!Object.hasOwn(combat.loadout,'extra'));
  assert.equal((await move(3, 'unknown')).activity,'attack');
  assert.equal((await move(4, 'idle')).activity,'idle');
});

test('the embedded desktop shares its saved position, outfit and sanitized agent scene with the browser', async t => {
  const {mkdtemp, rm, writeFile} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'guild-scene-'));
  t.after(() => rm(folder, {recursive:true,force:true}));
  const file = join(folder,'roster.json'), key = 'private:test:session', token = randomBytes(32).toString('hex');
  await writeFile(file,JSON.stringify({'runespace.snapshot': {at:Date.now()/1000, agents:[
    {key,kind:'Pi',name:'Host private chat',status:'working'}]}}));
  const {origin, post, connect} = await fixture(t, {agentRoster:file,desktop:{mod:'runespace',cli:'/app/herdr',token},sceneMaxAgeMs:400});
  for (const path of ['/embedded-guild.html','/embedded-guild.js','/agent-scene.js']) assert.equal((await fetch(origin+path)).status,200);
  const position={x:1,z:-6,yaw:.73};
  const login = async owner => (await post('/api/join',{invite:invitation,name:'Player',client:'herdr',position,owner})).json();
  const host=await login(token), guest=await login(invitation);
  const h=await connect(host.session), g=await connect(guest.session);
  const joined=await g.state(s=>s.peers.length===2);
  assert.equal(joined.peers.find(p=>p.id===host.id).z,position.z);
  assert.equal(joined.peers.find(p=>p.id===guest.id).z,position.z);
  const move={type:'move',x:8,z:3,yaw:.2,moving:true,activity:'wood',loadout:{head:'red-partyhat'},seq:1};
  const scene={type:'scene',agents:[[key,2,4,1,'farm',false],['hidden-session',5,6,1,'idle',true],[key,2,4,1,'arbitrary text',true]]};
  g.ws.send(JSON.stringify(scene));g.ws.send(JSON.stringify({...move,x:90}));
  const bounded = await g.state(s=>s.peers.find(p=>p.id===guest.id)?.seq===1);
  assert.ok(bounded.scene.length===1 && bounded.scene[0][4]!=='arbitrary text'); // canonical fallback for visiting Herdr
  assert.ok(Math.abs(bounded.peers.find(p=>p.id===guest.id).x - position.x) <= 1.601);
  h.ws.send(JSON.stringify(move));h.ws.send(JSON.stringify(scene));
  const snapshot=await g.state(s=>s.scene.length===1 && s.peers.find(p=>p.id===host.id)?.seq===1);
  const actor=snapshot.peers.find(p=>p.id===host.id);
  assert.equal(actor.x,8);assert.equal(actor.z,3);assert.equal(actor.loadout.head,'red-partyhat');
  assert.equal(actor.moving,true);assert.equal(actor.activity,'wood');
  assert.deepEqual(snapshot.scene,[[snapshot.agents[0].id,2,4,1,'farm',false]]);
  assert.doesNotMatch(JSON.stringify(snapshot),/private:|hidden-session|Host private chat/);
  // Keep audio presence connected and resume the visitor's fallback simulation.
  const fallback = s => s.scene.length===1 && (s.scene[0][1]!==2 || s.scene[0][2]!==4);
  await g.state(s=>fallback(s) && s.peers.length===2);
  h.ws.send(JSON.stringify(scene));
  await g.state(s=>s.scene.length===1 && !fallback(s));
  h.ws.send(JSON.stringify({type:'scene',agents:[]}));
  await g.state(s=>fallback(s) && s.peers.length===2);
  h.ws.send(JSON.stringify(scene));
  await g.state(s=>s.scene.length===1 && !fallback(s));
  h.ws.close();
  await g.state(s=>fallback(s) && s.peers.length===1);
  const resumed = await connect(host.session);
  resumed.ws.send(JSON.stringify(scene));
  await g.state(s=>s.scene.length===1 && !fallback(s));
  assert.equal((await post('/api/leave', {}, host.session)).status,200);
  await g.state(s=>fallback(s) && s.peers.length===1);
});


test('native guests restore only valid saved positions and ordinary browser joins spawn by the fire', async t => {
  const {post,connect} = await fixture(t);
  for (const [client,position,restored] of [
    ['herdr',{x:1,z:-6,yaw:.4},true],['browser',{x:1,z:-6,yaw:.4},false],
    ['herdr',{x:-16,z:-6,yaw:.4},false],['herdr',{x:900,z:-6,yaw:.4},false],
    ['herdr',{x:'1',z:-6,yaw:.4},false]
  ]) {
    const {id,session} = await (await post('/api/join',{invite:invitation,name:'Guest',client,position})).json();
    const socket = await connect(session);
    const me = (await socket.state(s=>s.self===id)).peers.find(p=>p.id===id);
    if (restored) assert.deepEqual([me.x,me.z],[position.x,position.z]);
    else assert.ok(Math.hypot(me.x,me.z-12)<4);
    await post('/api/leave',{},session);
  }
});


test('a native guest opening its renderer after joining gets one valid spawn update', async t => {
  const {post,connect} = await fixture(t);
  const {id,session} = await (await post('/api/join',{invite:invitation,name:'Guest',client:'herdr'})).json();
  const socket = await connect(session);
  const me = snapshot => snapshot.peers.find(p=>p.id===id);
  assert.equal(me(await socket.state(s=>s.self===id)).z,12);
  const send = (seq,x,z) => socket.ws.send(JSON.stringify({type:'move',seq,x,z,yaw:.3}));
  send(1,-16,-6); // water does not consume the spawn
  send(2,1,-6);
  const spawned = me(await socket.state(s=>me(s).seq===2));
  assert.deepEqual([spawned.x,spawned.z],[1,-6]);
  send(3,11,-3);
  const next = me(await socket.state(s=>me(s).seq===3));
  assert.ok(Math.hypot(next.x-spawned.x,next.z-spawned.z)<=1.601);
});

const localId = input => createHash('sha256').update(input).digest('hex');
const postRoster = (connection, agents, sharing = true, extra = {}) =>
  connection.ws.send(JSON.stringify({type:'roster', agents, sharing,...extra}));

async function enterDesktop(guild, name, key, options = {}) {
  const response = await guild.post('/api/join', {name, invite:invitation, client:'herdr', contributorKey:key, ...options});
  assert.equal(response.status,201);
  const player = await response.json();
  return {...player,...await guild.connect(player.session)};
}

test('two invited desktops share independently, occupy distinct workstations, and keep identifiers and conversations local', async t => {
  const guild=await fixture(t);
  const id=localId('opaque input'), aKey=localId('private install A'), bKey=localId('private install B');
  const alice=await enterDesktop(guild,'Alice',aKey,{shareAgents:true});
  const bob=await enterDesktop(guild,'Bob',bKey);
  const browser=await guild.connect((await guild.join('Web guest')).session);
  const raw={id,kind:'Codex',status:'working',name:'CONFIDENTIAL',cwd:'/private/client',ownerId:alice.id,chatTitle:'CONFIDENTIAL'};
  // Neither an opt-out desktop nor a browser can inject agents by publishing a normal scene/roster.
  bob.ws.send(JSON.stringify({type:'roster',agents:[raw]}));
  postRoster(browser,[raw]);
  postRoster(alice,[raw,{...raw,id:'private-session-key'},{...raw,id:localId('offline'),status:'offline'}]);
  let world=await browser.state(s=>s.agents.length===1);
  assert.equal(world.agents[0].ownerId,alice.id);
  assert.equal(world.scene.length,1);
  postRoster(bob,[raw]);
  world=await browser.state(s=>s.agents.length===2);
  assert.equal(world.sharedStations,true);
  assert.ok(world.agents.every(a=>a.status==='working' && a.name==='Codex mage 1' && !a.hostAgent));
  assert.deepEqual(new Set(world.agents.map(a=>a.ownerName)),new Set(['Alice','Bob']));
  const aliceId=world.agents.find(a=>a.ownerId===alice.id).id, bobId=world.agents.find(a=>a.ownerId===bob.id).id;
  assert.notEqual(aliceId,bobId);
  assert.deepEqual(new Set(world.scene.map(row=>row[0])),new Set([aliceId,bobId]));
  assert.equal(new Set(world.scene.map(row=>row.slice(1,3).join(','))).size,2);
  assert.ok(world.scene.every(row=>['wood','mine','smith','fish','farm'].includes(row[4])));
  assert.ok(!Object.hasOwn(world,'ownAgentIds'));
  for (const secret of [id,aKey,bKey,'CONFIDENTIAL','/private/client','private-session-key']) assert.ok(!JSON.stringify(world).includes(secret));
  const native=await alice.state(s=>s.agents.length===2);
  assert.deepEqual(native.ownAgentIds,{[id]:aliceId});
  assert.deepEqual(native.scene,world.scene);
  assert.equal((await guild.post('/api/agent-chat',{id:bobId},alice.session)).status,403);
  postRoster(bob,[],false);
  await browser.state(s=>s.agents.length===1 && s.agents[0].id===aliceId);
  // Re-enable, change status while the publisher is in a chat, and walk to the commons.
  postRoster(bob,[{...raw,status:'idle'}]);
  world=await browser.state(s=>s.scene.some(row=>row[0]===bobId && row[4]==='idle'));
  assert.equal(world.agents.find(a=>a.id===bobId).status,'idle');
  const before=world.scene.find(row=>row[0]===aliceId);
  postRoster(alice,[{...raw,status:'idle'}]);
  await browser.state(s=>s.scene.some(row=>row[0]===aliceId && row[4]==='idle' && row[5] && Math.hypot(row[1]-before[1],row[2]-before[2])>0));
  bob.ws.terminate();
  await browser.state(s=>s.agents.length===1 && !s.peers.some(p=>p.id===bob.id));
});

test('a returning installation retains its agents and its old socket cannot withdraw them', async t => {
  const guild=await fixture(t,{rosterMaxAgeMs:500});
  const source=localId('same desktop configuration'), id=localId('session z');
  const row={id,kind:'Pi',status:'working'};
  const browser=await guild.connect((await guild.join('Watch')).session);
  const old=await enterDesktop(guild,'Original',source,{shareAgents:true});
  postRoster(old,[row]);
  const original=(await browser.state(s=>s.agents.length===1)).agents[0].id;
  const replacement=await enterDesktop(guild,'Replacement',source);
  postRoster(replacement,[row]);
  let world=await browser.state(s=>s.agents.length===1 && s.agents[0].ownerId===replacement.id);
  assert.equal(world.agents[0].id,original);
  postRoster(old,[],false);
  postRoster(old,[{id:localId('old source'),kind:'Hermes',status:'working'}]);
  const staleReconnect=await guild.connect(old.session);
  postRoster(staleReconnect,[],false);
  await guild.post('/api/leave',{},old.session);
  world=await browser.state(s=>s.peers.length===2 && s.agents.length===1);
  assert.equal(world.agents[0].id,original);
  // An interrupted reporter expires even if the person stays connected.
  await browser.state(s=>s.peers.length===2 && s.agents.length===0 && !s.sharedStations);
  postRoster(replacement,[row]);
  await browser.state(s=>s.agents.length===1 && s.agents[0].id===original);
  await guild.post('/api/leave',{},replacement.session);
  await browser.state(s=>s.agents.length===0);
});

test('host file identities bind before publication and cannot be duplicated or commandeered by visitors', async t => {
  const {mkdtemp, rm, writeFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const folder=await mkdtemp(join(tmpdir(),'guild-team-host-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const file=join(folder,'roster.json'), raw='local conversation key', owner=randomBytes(32).toString('hex');
  await writeFile(file,JSON.stringify({'runespace.snapshot':{at:Date.now()/1000,agents:[
    {key:raw,kind:'Claude',name:'Private host topic',status:'working'}]}}));
  const guild=await fixture(t,{agentRoster:file,desktop:{mod:'runespace',cli:'/app/herdr',token:owner}});
  const host=await enterDesktop(guild,'Home',localId('home'),{owner});
  const key=createHmac('sha256',owner).update(raw).digest('hex');
  const own=await host.state(s=>s.agents.length===1);
  const hostId=own.agents[0].id;
  assert.equal(own.hostDesktop,true);
  assert.deepEqual(own.ownAgentIds,{[key]:hostId});
  const visitor=await enterDesktop(guild,'Visitor',localId('visiting'));
  let world=await visitor.state(s=>s.agents.some(a=>a.hostAgent));
  assert.ok(world.scene.some(row=>row[0]===hostId));
  assert.equal(world.agents[0].ownerId,host.id);
  assert.equal(world.hostDesktop,false);
  assert.deepEqual(world.ownAgentIds,{});
  assert.ok(!JSON.stringify(world).includes('Private host topic'));
  const hostScene=[[key,2,4,.4,'farm',false]];
  postRoster(host,[{id:key,kind:'Claude',status:'working'}],true,{scene:hostScene});
  await visitor.state(s=>s.scene.some(row=>row[0]===hostId && row[1]===2 && row[2]===4));
  postRoster(visitor,[{id:key,kind:'Claude',status:'working'}],true,{scene:hostScene});
  world=await host.state(s=>s.agents.length===2 && s.sharedStations);
  assert.equal(world.agents.filter(a=>a.hostAgent).length,1);
  const guestId=world.agents.find(a=>!a.hostAgent).id;
  assert.notEqual(guestId,hostId);
  assert.equal((await guild.post('/api/agent-chat',{id:guestId},host.session)).status,404);
  // Withdrawing the file-backed owner leaves visitor-owned agents in town.
  postRoster(host,[],false);
  await visitor.state(s=>s.agents.length===1 && s.agents[0].id===guestId);
  postRoster(host,[],true);
  await visitor.state(s=>s.agents.length===2);
});

test('a large gathering has distinct walkable commons positions after the ordinary fire rings fill', async t => {
  const guild=await fixture(t);
  const guest=await guild.connect((await guild.join('Observer')).session);
  const rows=Array.from({length:64},(_,i)=>({id:localId('token '+i),kind:'Agent',status:'idle'}));
  const publishers=await Promise.all(Array.from({length:4},(_,i)=>enterDesktop(guild,'Member '+i,localId('device '+i))));
  for (const person of publishers) postRoster(person,rows);
  const world=await guest.state(s=>s.scene.length===256);
  assert.equal(new Set(world.scene.map(row=>row.slice(1,3).join(','))).size,256);
  assert.ok(world.scene.every(row=>row[4]==='idle'));
});
