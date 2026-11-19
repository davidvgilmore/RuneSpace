import {createHmac, randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const salt = randomBytes(32);
const guildClasses = new Map([
  ['Codex', 'mage'], ['Claude', 'ranger'], ['OpenCode', 'warrior'],
  ['Pi', 'druid'], ['Hermes', 'guildmaster'], ['Agent', 'adventurer'],
]);

export const rosterId = key => createHmac('sha256', salt).update(key).digest('hex').slice(0, 18);

function conversationTitle(source) {
  if (typeof source.name !== 'string') return null;
  const title = source.name.trim();
  if (!title || /[\\/\p{Cc}\p{Cf}]/u.test(title) || /^(?:t[0-9a-z]{1,7}|[a-f\d-]{7,})$/i.test(title)) return null;
  if ([source.key, source.id, source.session, source.cwd].some(privateValue =>
    typeof privateValue === 'string' && privateValue && title.includes(privateValue))) return null;
  return [...title].slice(0, 96).join('');
}

async function readEntries(file, mod) {
  if (!file) return [];
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
  const now = Date.now() / 1000;
  const sources = mod === 'runespace' ? [data?.['runespace.snapshot']]
    : mod === 'guild-hall' ? [data?.['guild.snapshot']] : [data?.['runespace.snapshot'], data?.['guild.snapshot'], data];
  const snapshot = sources
    .filter(s => Number.isFinite(s?.at) && s.at <= now + 10 && now - s.at < 60 && Array.isArray(s.agents))
    .sort((a, b) => b.at - a.at)[0];
  if (!snapshot) return [];

  const roster = new Map();
  for (const source of snapshot.agents) {
    if (!source || typeof source.key !== 'string' || !source.key || source.mapVisible === false || source.connectionUnavailable ||
        ['unknown', 'offline'].includes(source.presence) || !['working', 'idle', 'blocked', 'error'].includes(source.status)) continue;
    const kind = guildClasses.has(source.kind) ? source.kind : 'Agent';
    const id = rosterId(source.key);
    roster.set(id, {id, kind, key:source.key, chatTitle:mod ? conversationTitle(source) : null, status: source.status === 'working' ? 'working' : 'idle'});
  }
  const serials = new Map();
  return [...roster.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 64).map(agent => {
    const serial = (serials.get(agent.kind) || 0) + 1;
    serials.set(agent.kind, serial);
    return {...agent, name: agent.kind + ' ' + guildClasses.get(agent.kind) + ' ' + serial};
  });
}

// Never send Herdr's desktop session key to a browser.
export async function readRosterViews(file, mod) {
  const guests = [], owner = [];
  for (const {id, kind, name, status, chatTitle} of await readEntries(file, mod)) {
    const common = {id, kind, name, status};
    guests.push(common);
    owner.push(chatTitle ? {...common, chatTitle} : common);
  }
  return {guests, owner};
}

export async function readRoster(file, mod) {
  return (await readRosterViews(file, mod)).guests;
}

export async function resolveAgentKey(file, mod, id) {
  if (!['guild-hall', 'runespace'].includes(mod) || typeof id !== 'string' || !/^[0-9a-f]{18}$/.test(id)) return null;
  const match = (await readEntries(file, mod)).find(agent => agent.id === id);
  return match?.key ?? null;
}
