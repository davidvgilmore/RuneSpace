import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation, poseFor, animationPhase, mergeAdventureProgress} from '../layout/mods/runespace/world-engine.js';

const entity=(sim,key)=>sim.adventure.entities.find(e=>e.key===key);

function until(sim, predicate, limit=30) {
  const deadline=sim.time+limit;
  while(!predicate()&&sim.time<deadline)sim.step(.05);
  assert.ok(predicate(),`Condition was not reached: ${sim.adventure.message}`);
}

test('approaching an oak, swinging to contact, harvesting just once and waiting for regrowth',()=>{
  const sim=new Simulation(),oak=entity(sim,'oak-by-market'),a=sim.adventure;
  assert.equal(sim.interact(oak.key),true);
  assert.ok(sim.path.length>0);
  assert.equal(a.logs,0);
  until(sim,()=>poseFor(sim.player)==='wood');
  assert.ok(Math.abs(Math.hypot(sim.player.x-oak.x,sim.player.z-oak.z)-1.4)<.01);
  assert.equal(animationPhase(sim.player,sim.time),0);
  const start=a.startedAt;
  assert.ok(sim.interact(oak.key));
  assert.equal(a.startedAt,start);
  until(sim,()=>oak.activity==='stump');
  assert.equal(a.logs,1);
  assert.equal(a.woodXp,25);
  assert.equal(sim.player.activity,'idle');
  assert.equal(sim.interact(oak.key),false);
  assert.equal(a.logs,1);
  until(sim,()=>oak.activity==='idle');
  assert.ok(sim.interact(oak.key));
  until(sim,()=>a.logs===2);
  assert.equal(a.woodXp,50);
});

test('creatures remain neutral until targeted, telegraph hits and respawn after a single reward',()=>{
  for(const [key,xp] of [['giant-rat',12],['goblin',20]]){
    const sim=new Simulation(),foe=entity(sim,key),a=sim.adventure;
    sim.player.x=foe.x;sim.player.z=foe.z+1.5;
    until(sim,()=>sim.time>=4);
    assert.equal(a.hp,a.maxHp);
    assert.equal(foe.hp,foe.maxHp);
    assert.ok(sim.interact(key));
    until(sim,()=>poseFor(sim.player)==='attack');
    assert.equal(animationPhase(sim.player,sim.time),0);
    assert.equal(foe.hp,foe.maxHp);
    until(sim,()=>foe.hit>0);
    assert.equal(foe.hp,foe.maxHp-foe.hit);
    until(sim,()=>foe.activity==='attack');
    assert.equal(a.hp,a.maxHp);
    until(sim,()=>sim.player.hit>0);
    assert.equal(a.hp,a.maxHp-sim.player.hit);
    until(sim,()=>foe.activity==='hidden');
    assert.equal(a.targetKey,null);
    assert.equal(a.combatXp,xp);
    assert.equal(sim.interact(key),false);
    assert.equal(sim.arrived,null);
    until(sim,()=>foe.activity==='idle');
    assert.equal(foe.hp,foe.maxHp);
    assert.equal(a.combatXp,xp);
  }
});

test('walking, movement keys, dance, escape and agent chats interrupt a long action',()=>{
  const agent={key:'codex/123',name:'Fix tests',status:'idle',host:'local',kind:'Codex'};
  const interruptions=[
    sim=>sim.walk({x:0,z:12}),sim=>sim.step(.1,{up:true}),sim=>sim.dance(),
    sim=>sim.cancelAdventure(),sim=>sim.approach(agent.key),
  ];
  for(const interrupt of interruptions){
    const sim=new Simulation();
    sim.sync([agent]);
    sim.interact('goblin');
    until(sim,()=>entity(sim,'goblin').hit>0);
    interrupt(sim);
    assert.equal(sim.adventure.targetKey,null);
    until(sim,()=>sim.time>=12);
    assert.equal(sim.adventure.combatXp,0);
    assert.equal(sim.adventure.hp,sim.adventure.maxHp);
    assert.equal(entity(sim,'goblin').hp,entity(sim,'goblin').maxHp);
  }
  const sim=new Simulation();
  sim.interact('oak-by-market');
  sim.cancelAdventure();
  assert.deepEqual(sim.path,[]);
  sim.interact('oak-by-market');
  until(sim,()=>sim.player.activity==='wood');
  sim.sync([agent]);
  assert.ok(sim.approach(agent.key));
  until(sim,()=>sim.arrived===agent.key);
  assert.equal(sim.adventure.logs,0);
  assert.equal(sim.player.activity,'idle');
  assert.equal(sim.interact(agent.key),false);
  assert.equal(sim.approach('goblin'),false);
});

test('player defeat returns to the commons while retaining earlier rewards',()=>{
  const sim=new Simulation(),a=sim.adventure;
  sim.restoreAdventure({version:1,logs:2,woodXp:50,combatXp:12,hp:1});
  sim.interact('goblin');
  until(sim,()=>a.message==='You recover at the commons.');
  assert.deepEqual([sim.player.x,sim.player.z],[0,12]);
  assert.deepEqual([a.hp,a.logs,a.woodXp,a.combatXp],[a.maxHp,2,50,12]);
  assert.equal(a.targetKey,null);
  assert.equal(sim.arrived,null);
  assert.equal(entity(sim,'goblin').activity,'idle');
});

test('keeps earned progress on returning, including cooldown time spent away',()=>{
  const sim=new Simulation();
  assert.equal(sim.restoreAdventure(),false);
  sim.interact('oak-by-market');
  until(sim,()=>sim.adventure.logs===1);
  sim.interact('giant-rat');
  until(sim,()=>sim.adventure.combatXp===12);
  const saved=JSON.parse(JSON.stringify(sim.saveAdventure(100000)));
  const resume=new Simulation();
  assert.equal(resume.restoreAdventure(saved,101500),true);
  assert.deepEqual(resume.saveAdventure(101500),saved);
  assert.equal(entity(resume,'oak-by-market').activity,'stump');
  assert.equal(entity(resume,'giant-rat').activity,'hidden');
  until(resume,()=>entity(resume,'giant-rat').activity==='idle');
  assert.equal(resume.adventure.combatXp,12);
  const later=new Simulation();
  later.restoreAdventure(saved,140000);
  assert.equal(entity(later,'oak-by-market').activity,'idle');
  assert.equal(entity(later,'giant-rat').activity,'idle');
  assert.deepEqual([later.adventure.logs,later.adventure.woodXp],[1,25]);
});

test('overlapping saves preserve independent rewards and apply only the local health change',()=>{
  const base={version:1,logs:1,woodXp:25,combatXp:0,hp:7,respawns:{},depletions:{'oak-by-market':1}};
  const local={...base,logs:2,woodXp:50,respawns:{'oak-by-lane':119000},
    depletions:{...base.depletions,'oak-by-lane':1}};
  const current={...base,combatXp:12,hp:5,respawns:{'giant-rat':113000},
    depletions:{...base.depletions,'giant-rat':1}};
  const inputs=structuredClone([base,local,current]);
  assert.deepEqual(mergeAdventureProgress(base,local,current,100000),{
    version:1,logs:2,woodXp:50,combatXp:12,hp:5,
    respawns:{'oak-by-lane':119000,'giant-rat':113000},
    depletions:{'oak-by-market':1,'oak-by-lane':1,'giant-rat':1},
  });
  assert.deepEqual([base,local,current],inputs);
  assert.equal(mergeAdventureProgress(base,{...local,hp:5},current).hp,3);
  assert.equal(mergeAdventureProgress(base,{...local,hp:1},current).hp,1);
  assert.equal(mergeAdventureProgress(base,{...local,hp:10},{...current,hp:9}).hp,10);
  assert.deepEqual(mergeAdventureProgress(null,null,null),{
    version:1,logs:0,woodXp:0,combatXp:0,hp:10,respawns:{},depletions:{},
  });
  assert.equal(mergeAdventureProgress(null,local,null).logs,2);
});

test('a paused oak stays regrown even when its neighbor is chopped in the stale view',()=>{
  const base={version:1,logs:1,woodXp:25,hp:10,depletions:{'oak-by-market':1},
    respawns:{'oak-by-market':99000}};
  const local={...base,logs:2,woodXp:50,depletions:{...base.depletions,'oak-by-lane':1},
    respawns:{'oak-by-market':119000,'oak-by-lane':118000}};
  const current={...base,respawns:{'giant-rat':97000}};
  assert.deepEqual(mergeAdventureProgress(base,local,current,100000).respawns,{'oak-by-lane':118000});
  const both={...current,logs:2,woodXp:50,respawns:{'oak-by-lane':120000},depletions:local.depletions};
  const raced=mergeAdventureProgress(base,local,both,100000);
  assert.equal(raced.depletions['oak-by-lane'],2);
  assert.equal(raced.logs,3);
  assert.deepEqual(raced.respawns,{'oak-by-lane':120000});
});

test('old saves without event counts can earn rewards and do not reanimate expired cooldowns',()=>{
  const base={version:1,hp:10,logs:1,woodXp:25,respawns:{'oak-by-lane':90000}};
  const local={...base,respawns:{'oak-by-lane':120000}};
  assert.deepEqual(mergeAdventureProgress(base,local,base,100000).respawns,{});
  assert.deepEqual(mergeAdventureProgress(base,{...local,logs:2,woodXp:50},base,100000).respawns,local.respawns);
  const sim=new Simulation();
  sim.restoreAdventure(base,100000);
  sim.interact('oak-by-lane');
  until(sim,()=>sim.adventure.logs===2);
  assert.deepEqual(sim.saveAdventure(100000).depletions,{'oak-by-lane':1});
});

test('reconciling progress preserves the current swing unless that target is depleted',()=>{
  const sim=new Simulation(),a=sim.adventure,goblin=entity(sim,'goblin');
  sim.interact(goblin.key);
  until(sim,()=>goblin.hit>0);
  const before=[a.targetKey,a.turn,a.landed,a.startedAt,goblin.hp,goblin.hit];
  const mine=sim.saveAdventure(100000);
  const merged={...mine,logs:1,woodXp:25,depletions:{'oak-by-market':1},respawns:{'oak-by-market':118000}};
  sim.reconcileAdventure(merged,100000);
  assert.deepEqual([a.targetKey,a.turn,a.landed,a.startedAt,goblin.hp,goblin.hit],before);
  assert.equal(entity(sim,'oak-by-market').activity,'stump');
  assert.equal(a.logs,1);
  sim.reconcileAdventure({...merged,respawns:{...merged.respawns,goblin:114000}},100000);
  assert.equal(a.targetKey,null);
  assert.equal(goblin.activity,'hidden');
  assert.equal(goblin.hp,0);
});
