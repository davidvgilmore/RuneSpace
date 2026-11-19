import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {classFor,heightFor} from '../layout/mods/runespace/world-art.js';
import {Simulation,animationPhase,poseFor} from '../layout/mods/runespace/world-engine.js';
import {normalizeLoadout,equippedPartKeys} from '../layout/mods/runespace/equipment.js';

const bridge = readFileSync(new URL('../layout/mods/runespace/metal/bridge.js', import.meta.url), 'utf8');
function host() {
  const api = vm.createContext({Simulation, classFor, heightFor, animationPhase, poseFor, normalizeLoadout, equippedPartKeys});
  vm.runInContext(bridge, api);
  api.guildInit('{}','null');
  return {api, frame:(dt=1/60) => JSON.parse(api.guildFrame(dt,'{}',0)),
    sync:peers => api.guildTeamSync(JSON.stringify(peers),'host')};
}
const guest = {id:'visitor',name:'Maple',x:2,z:11,yaw:0,activity:'idle',loadout:{head:'red-partyhat'}};

test('native humans have their own gear, actions and membership, separate from agent chat', () => {
  const {api, frame, sync} = host();
  const me = {id:'host',name:'Me',x:1,z:12,yaw:1};
  api.guildEquipment(JSON.stringify({head:'yellow-partyhat'}));
  sync([guest, me]);
  let world = frame();
  assert.equal(world.player.loadout.head,'yellow-partyhat');
  assert.equal(world.humans.length,1);
  assert.deepEqual(world.npcs,[]);
  assert.equal(world.humans[0].name,'Maple');
  assert.ok(world.humans[0].parts.includes('head:red-partyhat'));
  assert.equal(api.guildTalk(world.humans[0].key),false);
  assert.equal(api.guildVisit(guest.x,guest.z),true);
  assert.equal(frame().arrived,null);
  for (const activity of ['dance','wood','attack']) {
    sync([{...guest,activity}]);
    const [peer] = frame().humans;
    assert.equal(peer.activity,activity);
    assert.ok(peer.posePhase >= 0 && peer.posePhase < 1);
    if (activity === 'wood') assert.ok(peer.parts.includes('weapon:woodcutting-axe'));
  }
  sync([]);
  world = frame();
  assert.deepEqual(world.humans,[]);
  assert.equal(world.player.loadout.head,'yellow-partyhat');
});

test('native peer motion interpolates between snapshots at the local frame rate', () => {
  const {frame, sync} = host();
  sync([{...guest,yaw:Math.PI-.01}]);
  frame();
  sync([{...guest,x:2.5,yaw:-Math.PI+.01}]);
  const a=frame().humans[0], b=frame().humans[0];
  assert.ok(2<a.x && a.x<b.x && b.x<2.5);
  assert.equal(a.moving,true);
  assert.ok(Math.abs(b.yaw-Math.PI)<.02);
  let settled;
  for (let i=0; i<35; i++) settled=frame().humans[0];
  assert.equal(settled.moving,false);
  assert.ok(Math.abs(settled.x-2.5)<.001);
});

const worker={id:'opaque-worker',name:'Pi druid 1',ownerName:'Maple',kind:'Pi',status:'working',
  x:3.5,z:12,yaw:Math.PI-.03,activity:'mine',moving:false};

test('visiting workers use harness models, activity poses and ownership without entering the local inbox roster', () => {
  const {api, frame}=host();
  for (const [kind, activity] of [['Codex','smith'],['Claude','fish'],['Pi','farm'],['OpenCode','wood'],['Hermes','mine']]) {
    api.guildAgentsSync(JSON.stringify([{...worker,kind,activity}]));
    const view=frame(), actor=view.visitors[0];
    assert.equal(view.npcs.length,0);
    assert.equal(view.humans.length,0);
    assert.equal(actor.key,'visitor:opaque-worker');
    assert.equal(actor.ownerName,'Maple');
    assert.equal(actor.kind,kind);
    assert.equal(actor.activity,activity);
    assert.equal(actor.parts,undefined);
    assert.equal(api.guildTalk(actor.key),false);
    assert.equal(view.arrived,null);
  }
  api.guildAgentsSync(JSON.stringify([{...worker,x:4,yaw:-Math.PI+.03}]));
  const a=frame().visitors[0], b=frame().visitors[0];
  assert.ok(3.5<a.x && a.x<b.x && b.x<4);
  assert.ok(Math.abs(Math.abs(b.yaw)-Math.PI)<.04);
  assert.equal(a.moving,true);
  api.guildAgentsSync('[]');
  assert.deepEqual(frame().visitors,[]);
});

test('shared workstation placement preserves local chat identity and returns to local assignments on release', () => {
  const {api, frame}=host();
  api.guildSync(JSON.stringify([{key:'local-private',kind:'Claude',name:'Private title',status:'idle'}]),false);
  const original=frame().npcs[0];
  const remoteStation={key:original.key,x:2.5,z:11,yaw:1,activity:'farm',moving:false};
  api.guildStationsSync(JSON.stringify([remoteStation]));
  for(let i=0;i<50;i++)frame(.1);
  const assigned=frame().npcs[0];
  assert.equal(assigned.name,'Private title');
  assert.equal(assigned.key,'local-private');
  assert.equal(assigned.activity,'farm');
  assert.equal(assigned.moving,false);
  assert.ok(Math.hypot(assigned.x-2.5,assigned.z-11)<.001);
  assert.equal(api.guildTalk(assigned.key),true);
  api.guildAgentsSync('[]');assert.equal(frame().npcs[0].activity,'farm');
  api.guildStationsSync('[]');
  for (let i=0;i<350;i++)frame(.1);
  const released=frame().npcs[0];
  assert.equal(released.name,original.name);
  assert.equal(released.activity,'idle');
  assert.ok(Math.hypot(released.x-original.x,released.z-original.z)<.01);
});
