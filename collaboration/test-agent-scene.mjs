import assert from 'node:assert/strict';
import test from 'node:test';
import {Simulation} from '../layout/mods/runespace/world-engine.js';
import {createAgentScene} from './agent-scene.js';

test('host snapshots interpolate between updates and ordinary peer messages do not restart the walk', () => {
  const sim = new Simulation(), scene = createAgentScene(sim);
  const agents = [{id:'a', name:'Mage', kind:'Codex', status:'working'}];
  const advance = dt => {sim.step(dt); scene.draw();};
  scene.sync(agents, [['a',1,12,Math.PI-.05,'wood',false]]);
  const npc = sim.npcs.get('a');
  assert.equal(npc.x,1);
  for (let i=0; i<5; i++) advance(.05);
  const next = [['a',2,12,-Math.PI+.05,'wood',true]];
  scene.sync(agents, next);
  assert.equal(npc.x,1);
  advance(.05);
  const first = npc.x;
  assert.ok(1 < first && first < 2);
  assert.ok(Math.abs(npc.yaw-Math.PI)<.05);
  scene.sync(agents,next);
  advance(.05);
  assert.ok(first < npc.x && npc.x < 2);
  for (let i=0; i<4; i++) advance(.05);
  assert.equal(npc.x,2);
  assert.equal(npc.moving,true);
  scene.sync(agents,[['a',2,12,-Math.PI+.05,'wood',false]]);
  assert.equal(npc.moving,false);
  assert.equal(npc.path.length,0);
});

test('scene expiry gives NPCs a route from their last position and removes offline agents', () => {
  const sim = new Simulation(), scene = createAgentScene(sim);
  const agents = [{id:'a',name:'Mage',kind:'Codex',status:'working'}];
  scene.sync(agents,[['a',1,12,.4,'farm',false]]);
  const npc = sim.npcs.get('a');
  scene.sync(agents,[]);
  assert.equal(npc.x,1);
  assert.equal(npc.z,12);
  assert.ok(npc.path.length>0);
  sim.step(.05); scene.draw();
  assert.ok(Math.hypot(npc.x-1,npc.z-12)>0);
  scene.sync(agents,[['a',1,12,.4,'farm',false]]);
  assert.equal(npc.path.length,0);
  scene.sync([],[]);
  assert.equal(sim.npcs.size,0);
});
