export const IDLE_TIMEOUT_SECONDS = 30 * 60;

function timestamp(value, now) {
  return Number.isFinite(value) && value > 0 ? Math.min(value, now) : 0;
}

export function rosterStatus(agent) {
  return agent.presence === 'offline' || agent.presence === 'unknown' ? agent.presence : agent.status;
}

export function applyPresence(incoming, previous, now = incoming.at) {
  const prior = new Map((previous?.agents || []).map(a => [a.key, a]));
  const hosts = new Map(incoming.hosts.map(h => [h.id, h]));
  const agents = incoming.agents.map(agent => {
    const old = prior.get(agent.key);
    prior.delete(agent.key);
    const evidence = timestamp(agent.activityAt, now);
    const changed = old && old.status !== agent.status;
    const lastActivityAt = changed || agent.status === 'working' ? now
      : Math.max(evidence, timestamp(old?.lastActivityAt, now)) || now;
    const offline = agent.status === 'idle' && now - lastActivityAt >= IDLE_TIMEOUT_SECONDS;
    return {...agent, lastActivityAt, presence: offline ? 'offline' : agent.status === 'unknown' ? 'unknown' : 'online',
      mapVisible: !offline};
  });
  // A disconnected machine can disappear from the terminal list before reconnecting.
  for (const old of prior.values()) {
    const host = hosts.get(old.machineId);
    if (host && !host.online) agents.push({...old, presence:'unknown', mapVisible:false, connectionUnavailable:true});
  }
  return {...incoming, agents};
}
