// These functions run inside the mod's native game window via JavaScriptCore.
let guildSimulation;
const guildPeers = new Map();
const visitingWorkers = new Map();
let localStations = new Map();
let localRoster = [];
let localRosterStale = false;

function guildTeamSync(encoded, self) {
  const present = new Set();
  for (const peer of JSON.parse(encoded)) {
    if (!peer.id || peer.id === self || ![peer.x, peer.z, peer.yaw].every(Number.isFinite)) continue;
    present.add(peer.id);
    let p = guildPeers.get(peer.id);
    if (!p) {
      p = {key:'human:' + peer.id, player:true, x:peer.x, z:peer.z, yaw:peer.yaw,
        loadout:normalizeLoadout({}), moving:false, activity:'idle', walkUntil:0};
      guildPeers.set(peer.id, p);
    }
    const activity = ['wood','attack','dance'].includes(peer.activity) ? peer.activity : 'idle';
    if (activity !== p.activity) {
      p.actionStartedAt = guildSimulation.time;
      p.danceStartedAt = guildSimulation.time;
    }
    if (peer.moving === false) p.walkUntil = 0;
    else if (peer.moving && (p.tx !== peer.x || p.tz !== peer.z)) p.walkUntil = guildSimulation.time + 0.18;
    Object.assign(p, {name:peer.name || 'Teammate', tx:peer.x, tz:peer.z, tyaw:peer.yaw, activity});
    if (peer.loadout || peer.gear) p.loadout = normalizeLoadout(peer.loadout || peer.gear);
  }
  for (const id of guildPeers.keys()) if (!present.has(id)) guildPeers.delete(id);
}

// Use the same short interpolation for other players and their working companions.
function advanceGuildPose(actor, target, dt) {
  const dx=target.x-actor.x, dz=target.z-actor.z;
  const distance=Math.hypot(dx,dz);
  const blend=distance>4 ? 1 : -Math.expm1(-18*dt);
  actor.x+=dx*blend;
  actor.z+=dz*blend;
  const turn=target.yaw-actor.yaw;
  actor.yaw+=Math.atan2(Math.sin(turn),Math.cos(turn))*blend;
  return distance>.035 && distance<=4;
}

function guildTeamFrame(dt) {
  return Array.from(guildPeers.values(), p => {
    const moving=advanceGuildPose(p,{x:p.tx,z:p.tz,yaw:p.tyaw},dt);
    p.moving=p.activity==='idle' && (moving || p.walkUntil>guildSimulation.time);
    return {...guildActor(p),name:p.name,kind:'Teammate'};
  });
}

function guildAgentsSync(encoded) {
  const present=new Set();
  for (const agent of JSON.parse(encoded)) {
    if (!agent.id || ![agent.x,agent.z,agent.yaw].every(Number.isFinite)) continue;
    present.add(agent.id);
    let actor=visitingWorkers.get(agent.id);
    if (!actor) {
      actor={key:'visitor:'+agent.id,x:agent.x,z:agent.z,yaw:agent.yaw,host:'remote'};
      visitingWorkers.set(agent.id,actor);
    }
    Object.assign(actor,{name:agent.name,ownerName:agent.ownerName,kind:agent.kind,
      guildClass:classFor(agent.kind),height:heightFor(agent.kind),status:agent.status,activity:agent.activity,target:agent});
  }
  for (const id of visitingWorkers.keys()) if (!present.has(id)) visitingWorkers.delete(id);
}

function visitingFrame(dt) {
  return Array.from(visitingWorkers.values(), actor => {
    const moving=advanceGuildPose(actor,actor.target,dt);
    actor.moving=moving || actor.target.moving===true;
    return {...guildActor(actor),ownerName:actor.ownerName};
  });
}

function guildStationsSync(encoded) {
  const next=new Map();
  for (const pose of JSON.parse(encoded)) {
    if (pose.key && [pose.x,pose.z,pose.yaw].every(Number.isFinite)) next.set(pose.key,pose);
  }
  let released=false;
  for (const key of localStations.keys()) {
    const actor=guildSimulation.npcs.get(key);
    if (actor && !next.has(key)) {
      actor.dest=null;
      delete actor.sharedYaw;
      released=true;
    }
  }
  if (released) {
    guildSimulation.revision=null;
    guildSimulation.sync(localRoster,localRosterStale);
  }
  localStations=next;
}

function guildVisit(x, z) {
  const sim = guildSimulation;
  const angle = Math.atan2(sim.player.x - x, sim.player.z - z);
  // Stop alongside the teammate; agent inbox routing never handles human IDs.
  for (const offset of [0, 1, -1, 2, -2, 3, -3, 4]) {
    const a = angle + offset * Math.PI / 4;
    const goal = {x:x + Math.sin(a) * 1.6, z:z + Math.cos(a) * 1.6};
    if (!sim.blocked(goal.x, goal.z) && sim.clearSegment(goal, {x,z}) && sim.walk(goal)) return true;
  }
  return false;
}

function guildEquipment(encoded){
  guildSimulation.player.loadout=normalizeLoadout(JSON.parse(encoded||'{}'));
}
function guildInit(savedPositionJSON,adventureJSON) {
  guildPeers.clear();
  visitingWorkers.clear(); localStations.clear(); localRoster=[]; localRosterStale=false;
  guildSimulation=new Simulation();
  guildEquipment('{}');
  guildSimulation.restoreAdventure(readAdventureJSON(adventureJSON));
  const position=JSON.parse(savedPositionJSON||'{}')||{};
  if(Number.isFinite(position.x)&&Number.isFinite(position.z)&&!guildSimulation.blocked(position.x,position.z)){
    Object.assign(guildSimulation.player,{x:position.x,z:position.z});
    if (Number.isFinite(position.heading)) guildSimulation.player.yaw=position.heading;
  }
}
function guildSync(agentsJSON,stale) {
  localRoster=JSON.parse(agentsJSON);
  localRosterStale=stale;
  guildSimulation.sync(localRoster,stale);
}
function guildWalk(x,z) {return guildSimulation.walk({x,z});}
function guildTalk(key) {return guildSimulation.approach(key);}
function guildInteract(key) {return guildSimulation.interact(key);}
function readAdventureJSON(raw) {
  try {return JSON.parse(raw||'null');} catch(_) {return null;}
}
function guildSaveAdventure() {return JSON.stringify(guildSimulation.saveAdventure());}
function guildMergedAdventure(base,local,current) {
  return JSON.stringify(mergeAdventureProgress(readAdventureJSON(base),readAdventureJSON(local),readAdventureJSON(current)));
}
function guildReconcileAdventure(raw) {
  guildSimulation.reconcileAdventure(readAdventureJSON(raw));
  return guildSimulation.adventure.revision;
}
function guildDance() {return guildSimulation.dance();}
function guildStop() {
  guildSimulation.cancelAdventure();
  guildSimulation.stopDance();
  guildSimulation.targetKey=null;
  guildSimulation.arrived=null;
  guildSimulation.path=[];
}
let benchmarkPose;
function guildBenchmark(action) {
  const sim = guildSimulation;
  if (action === 'begin' && !benchmarkPose) {
    benchmarkPose = {
      x: sim.player.x, z: sim.player.z, yaw: sim.player.yaw,
      path: sim.path, target: sim.targetKey, arrived: sim.arrived,
    };
    guildStop();
    sim.player.x = 0;
    sim.player.z = 10.5;
  } else if (action === 'restore' && benchmarkPose) {
    const pose = benchmarkPose;
    Object.assign(sim.player, {x: pose.x, z: pose.z, yaw: pose.yaw});
    sim.path = pose.path;
    sim.targetKey = pose.target;
    sim.arrived = pose.arrived;
    benchmarkPose = null;
  }
}
function guildActor(p) {
  return {key:p.key,name:p.player?'You':p.name,host:p.host||'local',kind:p.player?'Player':p.kind,
    guildClass:p.guildClass||'Adventurer',height:p.height??2.10,
    status:p.status||'idle',activity:p.activity,hit:p.hit||0,x:p.x,z:p.z,yaw:p.yaw,moving:p.moving,
    parts:p.player?equippedPartKeys(p.loadout,poseFor(p)):undefined,
    posePhase:p.player&&['dance','wood','attack'].includes(p.activity)?animationPhase(p,guildSimulation.time):undefined};
}
function guildFrame(dt,keysJSON,yaw) {
  // Hold shared workers at their last visible position while local picking tests proximity.
  for (const key of localStations.keys()) {
    const actor=guildSimulation.npcs.get(key);
    if (actor) actor.path.length=0;
  }
  guildSimulation.step(dt,JSON.parse(keysJSON),yaw);
  for (const [key,pose] of localStations) {
    const actor=guildSimulation.npcs.get(key);
    if (!actor) continue;
    // Local station idle logic faces its own workstation each step. Interpolate
    // from the last shared heading so the visual turn follows the shared worker.
    if (actor.sharedYaw!==undefined) actor.yaw=actor.sharedYaw;
    const walking=advanceGuildPose(actor,pose,dt);
    actor.sharedYaw=actor.yaw;
    actor.moving=walking || pose.moving===true;
    actor.activity=pose.activity;
  }
  const arrived=guildSimulation.arrived;
  guildSimulation.arrived=null;
  const {entities,targetKey,message,hp,maxHp,logs,woodXp,combatXp,revision}=guildSimulation.adventure;
  return JSON.stringify({player:{...guildActor(guildSimulation.player),loadout:guildSimulation.player.loadout},
    humans:guildTeamFrame(dt),visitors:visitingFrame(dt),
    adventure:{entities,targetKey,message,hp,maxHp,logs,woodXp,combatXp,revision},
    npcs:Array.from(guildSimulation.npcs.values(),guildActor),arrived,time:guildSimulation.time});
}
