import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {Simulation,animationPhase,poseFor} from '../layout/mods/runespace/world-engine.js';
import {normalizeLoadout,equippedPartKeys} from '../layout/mods/runespace/equipment.js';

const bridge = readFileSync(new URL('../layout/mods/runespace/metal/bridge.js', import.meta.url), 'utf8');
function host() {
  const api = vm.createContext({Simulation, animationPhase, poseFor, normalizeLoadout, equippedPartKeys});
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
