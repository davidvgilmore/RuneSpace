// The desktop sends workstation poses less often than the browser renders frames.
// Simulation still owns the NPCs so picking, proximity and roster removal use the drawn positions.
export function createAgentScene(sim) {
  let targets = new Map();
  let rosterRevision;

  function draw() {
    for (const [id, pose] of targets) {
      const npc = sim.npcs.get(id);
      if (!npc) continue;
      const t = Math.min(1, (sim.time - pose.start) / pose.duration);
      npc.x = pose.fromX + (pose.x - pose.fromX) * t;
      npc.z = pose.fromZ + (pose.z - pose.fromZ) * t;
      npc.yaw = pose.fromYaw + pose.turn * t;
      npc.activity = pose.activity;
      npc.moving = pose.moving || (t < 1 && Math.hypot(pose.x - npc.x, pose.z - npc.z) > .035);
    }
  }

  function sync(agents, rows) {
    const ids = new Set(rows.map(row => row[0]));
    for (const id of targets.keys()) {
      if (ids.has(id)) continue;
      const npc = sim.npcs.get(id);
      if (npc) {
        // Recalculate a path from the last visible point to its local workstation.
        npc.dest = null;
        sim.revision = null;
        rosterRevision = undefined;
      }
    }
    const revision = JSON.stringify(agents);
    if (revision !== rosterRevision) {
      sim.sync(agents.map(agent => ({...agent, key:agent.id, host:'local'})));
      // An owner may rejoin under a new display name without changing the agent’s job.
      for (const agent of agents) {
        const npc = sim.npcs.get(agent.id);
        if (npc) Object.assign(npc, {ownerName:agent.ownerName, ownerId:agent.ownerId, hostAgent:agent.hostAgent});
      }
      rosterRevision = revision;
    }

    const next = new Map();
    for (const [id, x, z, yaw, activity, moving] of rows) {
      const npc = sim.npcs.get(id);
      if (!npc) continue;
      npc.path.length = 0;
      let pose = targets.get(id);
      if (!pose || x !== pose.x || z !== pose.z || yaw !== pose.yaw) {
        const snap = !pose || Math.hypot(x - npc.x, z - npc.z) > 4;
        const fromYaw = snap ? yaw : npc.yaw;
        const duration = pose ? Math.max(.10, Math.min(.35, sim.time - pose.start)) : .25;
        pose = {x, z, yaw, fromX:snap ? x : npc.x, fromZ:snap ? z : npc.z, fromYaw,
          turn:Math.atan2(Math.sin(yaw - fromYaw), Math.cos(yaw - fromYaw)), start:sim.time, duration};
      }
      pose.activity = activity;
      pose.moving = moving;
      next.set(id, pose);
    }
    targets = next;
    draw();
  }

  return {sync, draw};
}
