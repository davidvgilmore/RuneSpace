import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation, mergeAdventureProgress} from '../layout/mods/runespace/world-engine.js';
import {createAdventureProfile} from './adventure-profile.js';

function harness() {
  const data=new Map();
  const storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
  let queue=Promise.resolve();
  const locks={request(_key,write){return queue=queue.then(write);}};
  function player(name){
    const sim=new Simulation();
    const profile=createAdventureProfile(sim,{storage,locks,merge:mergeAdventureProgress});
    profile.open(name);
    return {sim,profile};
  }
  return {player};
}
function finish(sim,key){
  assert.ok(sim.interact(key));
  for(let i=0;i<600&&sim.adventure.targetKey;i++)sim.step(.05);
  assert.equal(sim.adventure.targetKey,null);
}

test('the browser restores a named adventurer’s gear, harvest, fight rewards and cooldowns separately from guests',async()=>{
  const {player}=harness(),{sim,profile}=player('Arden');
  finish(sim,'oak-by-market');finish(sim,'giant-rat');
  profile.writeGear({weapon:'dragon-scimitar'});await profile.save();profile.close();
  const returned=player('Arden'), other=player('Mira');
  assert.equal(returned.sim.adventure.woodXp,25);
  assert.equal(returned.sim.adventure.combatXp,12);
  assert.equal(returned.sim.adventure.entities.find(e=>e.key==='giant-rat').activity,'hidden');
  assert.equal(returned.profile.readGear().weapon,'dragon-scimitar');
  assert.equal(other.sim.adventure.logs,0);assert.equal(other.profile.readGear(),null);
});

test('browser tabs merging concurrent personal adventure gains preserve both rewards',async()=>{
  const {player}=harness(),a=player('Mage'),b=player('Mage');
  finish(a.sim,'oak-by-lane');finish(b.sim,'goblin');
  await Promise.all([a.profile.save(),b.profile.save()]);
  const resumed=player('Mage').sim.adventure;
  assert.equal(resumed.logs,1);assert.equal(resumed.woodXp,25);assert.equal(resumed.combatXp,20);
});
