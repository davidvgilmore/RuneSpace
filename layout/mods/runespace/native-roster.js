// Pure adapter for Herdr's agents(), terminals(), spaces(), and machines() snapshots.
import { applyPresence } from './roster-presence.js';

function machineId(name) {
  return name ? 'peer/' + name : 'local';
}

function machineFromAddress(address) {
  const slash = address.indexOf('/');
  return slash < 0 ? null : address.slice(0, slash);
}

function machineInfo(name, state) {
  let hash = 0;
  for (const letter of name || '') hash = (hash * 31 + letter.charCodeAt(0)) | 0;
  return {
    id: machineId(name),
    name: name || 'This computer',
    crest: name ? (hash & 1 ? 'remote' : 'other') : 'local',
    online: state === 'ready',
    state,
  };
}

function kindOf(agent, terminal) {
  const program = agent?.program || terminal?.program;
  const identities = [agent?.app, program?.key, program?.name, terminal?.report?.app];
  for (const value of identities) {
    const id = String(value || '').toLowerCase();
    if (/^(claude|claude[- ]code)$/.test(id)) return 'Claude';
    if (/^(codex|openai[- ]codex)$/.test(id)) return 'Codex';
    if (/^open[- ]?code$/.test(id)) return 'OpenCode';
    if (/^hermes([- ]agent)?$/.test(id)) return 'Hermes';
  }
  return program?.name || agent?.app || 'Agent';
}

function usefulTitle(value, kind, program, address) {
  const name = String(value || '').replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}~/]+/u, '')
    .replace(/^\[ [!.] \] /, '').replace(/\s+/g, ' ').trim();
  if (!name || /^[~/]|^[A-Z]:\\|^[\w.-]+@[\w.-]+:/i.test(name)) return '';
  if (/^(?:\d+|t\d+|[0-9a-f]{7,}|[0-9a-f]{8}-[0-9a-f-]{20,})$/i.test(name)) return '';
  const generic = [kind, program?.key, program?.name, address, 'Agent', 'Untitled'];
  return generic.some(item => String(item || '').toLowerCase() === name.toLowerCase()) ? '' : name;
}

function statusOf(raw) {
  if (raw === 'done') return 'idle';
  return ['working', 'blocked', 'idle', 'error'].includes(raw) ? raw : 'unknown';
}

export function nativeRoster({agents, terminals, spaces, machines}, previous, now = Date.now() / 1000) {
  const hosts = new Map(machines.map(m => [machineId(m.name), machineInfo(m.name, m.layout)]));
  const spaceById = new Map(spaces.map(s => [s.id, s]));
  const tabById = new Map(spaces.flatMap(s => s.tabs.map(t => [t.id, t])));
  const live = new Map(terminals.filter(t => t.state === 'live').map(t => [t.address, t]));
  const listed = new Map(agents.map(a => [a.address, a]));
  const addresses = new Set(listed.keys());
  for (const terminal of live.values()) {
    if (terminal.program?.agent) addresses.add(terminal.address);
  }

  const rows = [];
  for (const address of addresses) {
    if (typeof address !== 'string' || !address) continue;
    const a = listed.get(address), terminal = live.get(address);
    const space = spaceById.get(a?.space), tab = tabById.get(a?.tab);
    const machine = space ? space.machine : machineFromAddress(address);
    const id = machineId(machine);
    if (!hosts.has(id)) hosts.set(id, machineInfo(machine, 'ready'));
    const host = hosts.get(id);
    if (!host.online) continue;
    const kind = kindOf(a, terminal);
    const title = value => usefulTitle(value, kind, a?.program || terminal?.program, address);
    const sessionTitle = title(a?.title) || title(terminal?.title) || title(terminal?.name);
    const tabTitle = title(tab?.name || a?.tab_name);
    const fallback = title(space?.name || a?.space_name);
    // Keep user-named tabs. In split tabs, each pane's session title distinguishes its agent.
    const name = (tab?.named && tab.panes === 1 ? tabTitle : '') || sessionTitle || tabTitle
      || (fallback ? fallback + ' · ' : '') + kind;
    const evidence = tab?.panes === 1 && Number.isFinite(tab.changed_at) ? tab.changed_at / 1000 : 0;
    rows.push({
      key: address, kind, name, host: host.crest, machineId: host.id, machineName: host.name,
      status: statusOf(a?.status || terminal?.status), activityAt: evidence,
      openAction: a || terminal?.parent ? 'agent.focus' : 'terminal.peek',
    });
  }

  // Homonymous sessions on a machine still need distinguishable world labels.
  const counts = new Map();
  for (const a of rows) {
    const id = JSON.stringify([a.machineId, a.name]);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  for (const a of rows) {
    if (counts.get(JSON.stringify([a.machineId, a.name])) > 1) a.name += ' · ' + a.key.split('/').pop();
  }
  return applyPresence({at: now, hosts: [...hosts.values()], agents: rows}, previous);
}
