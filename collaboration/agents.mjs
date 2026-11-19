import {createHmac, randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const salt = randomBytes(32);
const guildClasses = new Map([
  ['Codex', 'mage'], ['Claude', 'ranger'], ['OpenCode', 'warrior'],
  ['Pi', 'druid'], ['Hermes', 'guildmaster'], ['Agent', 'adventurer'],
]);

// Only these four fields cross from the desktop roster into the team world.
export async function readRoster(file) {
  if (!file) return [];
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
  const now = Date.now() / 1000;
  const snapshot = [data?.['runespace.snapshot'], data?.['guild.snapshot'], data]
    .filter(s => Number.isFinite(s?.at) && s.at <= now + 10 && now - s.at < 60 && Array.isArray(s.agents))
    .sort((a, b) => b.at - a.at)[0];
  if (!snapshot) return [];

  const roster = new Map();
  for (const source of snapshot.agents) {
    if (!source || typeof source.key !== 'string' || !source.key || source.mapVisible === false ||
        ['unknown', 'offline'].includes(source.presence) || !['working', 'idle', 'blocked', 'error'].includes(source.status)) continue;
    const kind = guildClasses.has(source.kind) ? source.kind : 'Agent';
    const id = createHmac('sha256', salt).update(source.key).digest('hex').slice(0, 18);
    roster.set(id, {id, kind, name: '', status: source.status === 'working' ? 'working' : 'idle'});
  }
  const serials = new Map();
  return [...roster.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 64).map(agent => {
    const serial = (serials.get(agent.kind) || 0) + 1;
    serials.set(agent.kind, serial);
    return {...agent, name: agent.kind + ' ' + guildClasses.get(agent.kind) + ' ' + serial};
  });
}
