// These functions run inside the mod's native game window via JavaScriptCore.
let guildSimulation;
function guildEquipment(encoded){
  guildSimulation.player.loadout=normalizeLoadout(JSON.parse(encoded||'{}'));
}
function guildInit(savedPositionJSON) {
  guildSimulation=new Simulation();
  guildEquipment('{}');
  const position=JSON.parse(savedPositionJSON||'{}')||{};
  if(Number.isFinite(position.x)&&Number.isFinite(position.z)&&!guildSimulation.blocked(position.x,position.z)){
    Object.assign(guildSimulation.player,{x:position.x,z:position.z});
  }
}
function guildSync(agentsJSON,stale) {
  guildSimulation.sync(JSON.parse(agentsJSON),stale);
}
function guildWalk(x,z) {return guildSimulation.walk({x,z});}
function guildTalk(key) {return guildSimulation.approach(key);}
function guildDance() {return guildSimulation.dance();}
function guildStop() {
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
    status:p.status||'idle',activity:p.activity,x:p.x,z:p.z,yaw:p.yaw,moving:p.moving,
    parts:p.player?equippedPartKeys(p.loadout,poseFor(p)):undefined,
    dancePhase:p.player&&p.activity==='dance'?animationPhase(p,guildSimulation.time):undefined};
}
function guildFrame(dt,keysJSON,yaw) {
  guildSimulation.step(dt,JSON.parse(keysJSON),yaw);
  const arrived=guildSimulation.arrived;
  guildSimulation.arrived=null;
  return JSON.stringify({player:guildActor(guildSimulation.player),
    npcs:Array.from(guildSimulation.npcs.values(),guildActor),arrived,time:guildSimulation.time});
}
