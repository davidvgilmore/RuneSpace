import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation,Camera,Mesh,distance,STATIONS,character,clipFor,poseFor,animationPhase,MOTION} from '../layout/mods/runespace/world-engine.js';

const agent=(i,status='idle')=>({key:`${i%3===0?'remote':i%3===1?'local':'other'}/session:${i}`,name:`Project ${i}`,status,host:i%3===0?'remote':i%3===1?'local':'other',kind:'Codex'});
const settle=(sim,max=1000)=>{for(let i=0;i<max;i++)sim.step(.05);};

test('the equipped fire cape animates at rest while idle companions reuse one frame',()=>{
  const player=new Simulation().player,companion=agent(0);
  const clip=clipFor(player,'idle');
  assert.ok(clip.frames>1);
  assert.equal(clipFor(companion,'idle').frames,1);
  assert.equal(animationPhase(companion,0),animationPhase(companion,1));
  const first=character(player,0).faces,second=character(player,clip.seconds*.25).faces;
  assert.deepEqual(first.map(f=>f.points.length),second.map(f=>f.points.length));
  assert.ok(first.some((face,i)=>face.color!==second[i].color || face.points.some((point,k)=>
    point.some((v,j)=>Math.abs(v-second[i].points[k][j])>.001))));
});

test('a player dance starts on its own beat, can restart, and settles in place',()=>{
  const sim=new Simulation(),p=sim.player;
  sim.sync([agent(0,'working'),agent(1)]);settle(sim,13);
  const companions=[...sim.npcs.values()].map(p=>p.activity);
  assert.ok(sim.walk({x:3,z:9}));
  const {x,z}=p;
  sim.dance();assert.equal(sim.path.length,0);assert.equal(poseFor(p),'dance');
  assert.equal(animationPhase(p,sim.time),0);
  settle(sim,20);assert.ok(Math.abs(animationPhase(p,sim.time)-.25)<1e-8);
  sim.dance();assert.equal(animationPhase(p,sim.time),0);
  settle(sim,Math.ceil(MOTION.dance.seconds/.05)+1);
  assert.equal(poseFor(p),'idle');assert.deepEqual([p.x,p.z],[x,z]);
  assert.deepEqual([...sim.npcs.values()].map(p=>p.activity),companions);
  assert.equal(poseFor({activity:'dance'}),'idle');
});

test('arrows, walking to a point and approaching a companion each interrupt the dance',()=>{
  const sim=new Simulation();const companion=agent(1);sim.sync([companion]);
  sim.dance();sim.step(.05,{up:true});assert.equal(poseFor(sim.player),'walk');
  sim.dance();sim.walk({x:0,z:10});assert.equal(sim.player.activity,'idle');
  sim.dance();sim.approach(companion.key);assert.equal(sim.player.activity,'idle');
  sim.dance();sim.stopDance();assert.equal(poseFor(sim.player),'idle');
});

test('ground picking round-trips through camera tilt, orbit and zoom',()=>{
  for(const pitch of [.35,.82,1.35])for(const yaw of [0,.18,1.5,3.2,5.8])for(const size of [[900,650],[2560,1340]]){
    const camera=new Camera(...size,{x:4,z:3},yaw,1.6,pitch);
    for(const [x,z] of [[0,0],[-13,3],[11,-7],[4,18]]){
      const p=camera.project([x,0,z]),q=camera.ground(p.x,p.y);
      assert.ok(Math.abs(q.x-x)<1e-9&&Math.abs(q.z-z)<1e-9);
    }
  }
});

test('camera tilt changes elevation and keeps saved angles within a pickable range',()=>{
  const camera=pitch=>new Camera(900,650,{x:0,z:0},0,1,pitch);
  const low=camera(-2),high=camera(2);
  assert.equal(low.pitch,.35);assert.equal(high.pitch,1.35);
  assert.equal(camera().pitch,.82);assert.equal(camera(NaN).pitch,.82);
  const characterHeight=c=>c.project([0,0,0]).y-c.project([0,2,0]).y;
  assert.ok(characterHeight(low)>characterHeight(high));
  assert.ok(low.project([0,0,10]).y<high.project([0,0,10]).y);
});

test('click walking routes around buildings and across the bridge',()=>{
  const sim=new Simulation();
  for(const end of [{x:0,z:-16},{x:-19.5,z:-7},...Object.values(STATIONS).flat()]){
    const path=sim.findPath(sim.player,end);
    assert.ok(path.length,JSON.stringify(end));
    for(const p of path)assert.equal(sim.blocked(p.x,p.z),false);
    let from=sim.player;
    for(const p of path){
      for(let i=1;i<=5;i++)assert.equal(sim.blocked(from.x+(p.x-from.x)*i/5,from.z+(p.z-from.z)*i/5),false);
      from=p;
    }
  }
});

test('thirty idle companions have distinct, walkable commons positions',()=>{
  const sim=new Simulation();sim.sync(Array.from({length:30},(_,i)=>agent(i)));
  const points=new Set();
  for(const p of sim.npcs.values()){
    assert.equal(sim.blocked(p.x,p.z),false,p.key);
    assert.ok(distance(p,{x:0,z:3})<8.1);
    points.add(`${p.x},${p.z}`);
  }
  assert.equal(points.size,30);
});

test('working companions stand outside the objects they interact with',()=>{
  const sim=new Simulation();sim.sync(Array.from({length:32},(_,i)=>agent(i,'working')));
  for(const p of sim.npcs.values())assert.equal(sim.blocked(p.x,p.z),false,p.key+' '+p.activity);
});

test('a working companion travels to a skill station and returns; others keep their places',()=>{
  const sim=new Simulation(),agents=Array.from({length:28},(_,i)=>agent(i));sim.sync(agents);
  const positions=new Map([...sim.npcs.values()].map(p=>[p.key,{x:p.x,z:p.z}]));
  agents[0]={...agents[0],status:'working'};sim.sync(agents);
  assert.ok(STATIONS[sim.npcs.get(agents[0].key).activity]);settle(sim);
  const worker=sim.npcs.get(agents[0].key);assert.ok(distance(worker,worker.dest)<.6);
  for(const a of agents.slice(1))assert.equal(distance(sim.npcs.get(a.key),positions.get(a.key)),0);
  agents[0]={...agents[0],status:'idle'};sim.sync(agents);settle(sim);
  assert.equal(worker.activity,'idle');assert.ok(distance(worker,{x:0,z:3})<8.1);
});

test('approaching every host returns the exact existing session key',()=>{
  const sim=new Simulation(),agents=Array.from({length:28},(_,i)=>agent(i,i<8?'working':'idle'));sim.sync(agents);
  for(const a of agents){
    sim.player.x=0;sim.player.z=12;sim.approach(a.key);
    for(let i=0;i<1200&&!sim.arrived;i++)sim.step(.05);
    assert.equal(sim.arrived,a.key,a.key);assert.ok(distance(sim.player,sim.npcs.get(a.key))<2.6);
    sim.arrived=null;
  }
});

test('stale observations stop work and removed agents cannot open a chat',()=>{
  const sim=new Simulation(),a=agent(5,'working');sim.sync([a]);sim.sync([a],true);
  assert.equal(sim.npcs.get(a.key).activity,'unknown');assert.equal(sim.wasStale,true);
  sim.approach(a.key);sim.sync([]);assert.equal(sim.targetKey,null);assert.equal(sim.approach(a.key),false);
});

test('camera keys leave the player in place and arrows walk relative to the view',()=>{
  const sim=new Simulation();const {x,z}=sim.player;
  for(const letter of 'wasdqerf')sim.step(.05,{[letter]:true},.5);
  assert.equal(sim.player.x,x);assert.equal(sim.player.z,z);
  sim.step(.05,{up:true},Math.PI/2);
  assert.ok(sim.player.x<x);assert.ok(Math.abs(sim.player.z-z)<1e-6);
});

test('arrow-key movement respects river and building collision',()=>{
  const sim=new Simulation();sim.player.x=0;sim.player.z=-7;
  for(let i=0;i<100;i++)sim.step(.05,{up:true},0);
  assert.equal(sim.blocked(sim.player.x,sim.player.z),false);assert.ok(sim.player.z>-8.3);
  sim.player.x=-13;sim.player.z=-4;
  for(let i=0;i<100;i++)sim.step(.05,{left:true},0);
  assert.equal(sim.blocked(sim.player.x,sim.player.z),false);assert.ok(sim.player.x>-13.4);
});

test('pointed flame geometry survives backface culling',()=>{
  const m=new Mesh();m.cone(0,0,0,.5,1,'#eeaa55',6,0);
  assert.ok(new Camera(900,650).faces(m).length>0);
});

test('tools touch the corresponding resource at the work phase, with a walkable chat approach',()=>{
  const sim=new Simulation(),agents=Array.from({length:5},(_,i)=>agent(i,'working'));
  sim.sync(agents);
  const close={wood:[.50,.28,.7,1.3],mine:[.50,.64,.55,1.05],smith:[.50,.24,1.09,1.19],
    farm:[.375,.48,0,.26],fish:[.50,.16,.025,.17]};
  assert.deepEqual(new Set([...sim.npcs.values()].map(p=>p.activity)),new Set(Object.keys(close)));
  const effectColors=new Set(['#d3ae6d','#d2c59c','#ffbd5c','#93704c','#90b8af']);
  for(const p of sim.npcs.values()){
    const [phase,radius,minY,maxY]=close[p.activity],asset=character({...p,posePhase:phase},0),placed=new Mesh();
    placed.transformed(asset,p.x,p.z,p.yaw);
    const contact=placed.faces.some(f=>!effectColors.has(f.color)&&f.points.some(([x,y,z])=>
      Math.hypot(x-p.dest.faceX,z-p.dest.faceZ)<=radius&&y>=minY&&y<=maxY));
    assert.ok(contact,p.activity+' tool should meet the actual tree, rock, anvil, water, or soil');
    assert.equal(sim.blocked(p.x,p.z),false);
    if(p.activity==='fish')assert.ok(p.dest.faceX>-18.8&&p.dest.faceX<-13.4&&!(p.dest.faceZ>1.9&&p.dest.faceZ<4.1));
    sim.player.x=0;sim.player.z=12;assert.ok(sim.approach(p.key));
    for(let i=0;i<1200&&!sim.arrived;i++)sim.step(.05);
    assert.equal(sim.arrived,p.key);assert.ok(sim.clearSegment(sim.player,p));sim.arrived=null;
  }
});

test('full skill rosters use distinct reachable places, with stable workers and a fair overflow queue',()=>{
  const sim=new Simulation(),capacity=Object.values(sim.stations).reduce((n,slots)=>n+slots.length,0);
  const agents=Array.from({length:capacity+2},(_,i)=>agent(i,'working'));
  sim.sync(agents);
  const waiters=[...sim.npcs.values()].filter(p=>p.activity==='waiting');
  assert.equal(waiters.length,2);
  const workers=[...sim.npcs.values()].filter(p=>p.slotGroup!=='commons'),positions=new Map(workers.map(p=>[p.key,p.dest]));
  for(const p of workers){
    const path=sim.findPath(sim.player,p.dest);
    assert.ok(path.length&&distance(path.at(-1),p.dest)<1e-8,p.activity+': '+p.key);
    assert.ok(workers.every(peer=>p===peer||distance(peer,p)>=.75));
  }
  const departing=workers.find(p=>p.activity==='fish'),remaining=agents.filter(a=>a.key!==departing.key);
  sim.sync(remaining.reverse().map(a=>({...a,name:a.name+' updated'})));
  const replacement=waiters.find(p=>p.activity==='fish');
  assert.equal(replacement?.dest,positions.get(departing.key));
  for(const p of workers)if(p!==departing)assert.equal(p.dest,positions.get(p.key));
});

test('all five skills transition through walking to the exact contact point and reuse it on reconnect',()=>{
  const sim=new Simulation(),agents=Array.from({length:5},(_,i)=>agent(i));
  sim.sync(agents);
  for(const a of agents)a.status='working';
  sim.sync(agents);sim.step(.05);
  const workers=[...sim.npcs.values()],assigned=new Map(workers.map(p=>[p.key,p.dest]));
  assert.deepEqual(new Set(workers.map(p=>p.activity)),new Set(Object.keys(STATIONS)));
  for(const p of workers)assert.equal(poseFor(p),'walk');
  sim.sync([...agents].reverse().map(a=>({...a,name:a.name+' revised'})));
  settle(sim);
  for(const p of workers){
    assert.equal(p.dest,assigned.get(p.key));
    assert.ok(distance(p,p.dest)<1e-8,p.activity);
    assert.equal(poseFor(p),p.activity);
    assert.equal(p.yaw,Math.atan2(p.dest.faceX-p.x,p.dest.faceZ-p.z));
    assert.ok(MOTION[p.activity].frames>=16);
  }
  sim.sync(agents,true);settle(sim);
  assert.ok(workers.every(p=>p.activity==='unknown'&&p.slotGroup==='commons'));
  sim.sync(agents,false);settle(sim);
  assert.ok(workers.every(p=>p.dest===assigned.get(p.key)&&distance(p,p.dest)<1e-8));
});
