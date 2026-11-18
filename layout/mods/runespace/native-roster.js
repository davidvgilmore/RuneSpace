// Pure adapter for Herdr's agent, terminal, pane, space and machine snapshots.
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
  const identities = [agent?.app, terminal?.report?.app, program?.key, program?.name,
    terminal?.program?.key, terminal?.program?.name];
  for (const value of identities) {
    const id = String(value || '').trim().toLowerCase();
    if (/^(claude|claude[- ]code)$/.test(id)) return 'Claude';
    if (/^(codex|openai[- ]codex)$/.test(id)) return 'Codex';
    if (/^open[- ]?code$/.test(id)) return 'OpenCode';
    if (/^pi(?:[- ]coding[- ]agent)?$/.test(id)) return 'Pi';
    if (/^hermes([- ]agent)?$/.test(id)) return 'Hermes';
  }
  return program?.name || agent?.app || 'Agent';
}

// Older harnesses can be in the foreground without sending a Program Status
// Protocol report. Only recognize interactive invocations in that case.
const nonInteractiveOpenCodeCommands = new Set(['acp','agent','api','auth','completion','db','debug','export','generate',
  'github','import','login','logout','mcp','models','pair','plugin','pr','providers','reload','run','serve',
  'service','session','stats','uninstall','update','upgrade','web']);
const openCodeValueOptions = new Set(['--agent','--config','--dir','--hostname','--log-level','--model','-m',
  '--port','--prompt','--server','--session','-s','--theme']);
const piCommands = new Set(['install','remove','uninstall','update','list','config']);
const processName = path => path.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');

function interactiveHarness(terminal) {
  // Like Herdr's program resolver, prefer the foreground over the original
  // launch command: a pane can return to its shell without closing.
  let argv = terminal.foreground?.argv?.length ? terminal.foreground.argv : terminal.argv;
  if (!Array.isArray(argv) || !argv.length) return null;
  if (argv.length > 4 && ['bash','zsh','sh','fish'].includes(processName(argv[0])) && /^-.*c$/.test(argv[1]) && [
    '"$@"; exec "$0" -i', '"$@"; exec "$0" -li',
    'command $argv[2..]; exec $argv[1] -i', 'command $argv[2..]; exec $argv[1] -li',
  ].includes(argv[2])) argv = argv.slice(4);
  let name = processName(argv[0]), args = argv.slice(1);
  if (name === 'node' && args[0]) {
    const script = args[0].replaceAll('\\','/');
    if (/(?:^|\/)@(?:earendil-works|mariozechner)\/pi-coding-agent\/dist\/cli\.js$/.test(script)) name = 'pi';
    else if (/(?:^|\/)opencode-ai\/bin\/opencode$/.test(script)) name = 'opencode';
    else name = processName(script);
    args = args.slice(1);
  }
  if (!['pi','opencode'].includes(name)) return null;
  if (args.some(arg => ['--help','-h','--version','-v','--completions'].includes(arg))) return null;
  if (name === 'pi') {
    const headless = args.some((arg, i) => ['-p','--print','--export','--list-models'].includes(arg)
      || /^--(?:mode=(?:json|rpc)$|export=|list-models=)/.test(arg)
      || (arg === '--mode' && ['json','rpc'].includes(args[i+1])));
    if (piCommands.has(args[0]) || headless) return null;
    return 'Pi';
  }
  for (let i=0; i<args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (!arg.startsWith('-')) return nonInteractiveOpenCodeCommands.has(arg) ? null : 'OpenCode';
    if (openCodeValueOptions.has(arg)) i++;
  }
  return 'OpenCode';
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

export function nativeRoster({agents, terminals, spaces, machines, panes = []}, previous, now = Date.now() / 1000) {
  const hosts = new Map(machines.map(m => [machineId(m.name), machineInfo(m.name, m.layout)]));
  const spaceById = new Map(spaces.map(s => [s.id, s]));
  const tabById = new Map(spaces.flatMap(s => s.tabs.map(t => [t.id, t])));
  const paneByAddress = new Map(panes.map(p => [p.terminal, p]));
  const live = new Map(terminals.filter(t => t.state === 'live').map(t => [t.address, t]));
  const listed = new Map(agents.map(a => [a.address, a]));
  const addresses = new Set(listed.keys());
  const interactive = new Map();
  for (const terminal of live.values()) {
    if (terminal.program?.agent) addresses.add(terminal.address);
    else if (!listed.has(terminal.address)) {
      const kind = interactiveHarness(terminal);
      if (kind) {
        interactive.set(terminal.address, kind);
        addresses.add(terminal.address);
      }
    }
  }

  const rows = [];
  for (const address of addresses) {
    if (typeof address !== 'string' || !address) continue;
    const a = listed.get(address), terminal = live.get(address);
    const pane = paneByAddress.get(address);
    const space = spaceById.get(a?.space), tab = tabById.get(a?.tab || pane?.tab);
    const machine = space ? space.machine : machineFromAddress(address);
    const id = machineId(machine);
    if (!hosts.has(id)) hosts.set(id, machineInfo(machine, 'ready'));
    const host = hosts.get(id);
    if (!host.online) continue;
    const kind = interactive.get(address) || kindOf(a, terminal);
    const title = value => usefulTitle(value, kind, a?.program || terminal?.program, address);
    const sessionTitle = title(terminal?.report?.title) || title(a?.title) || title(terminal?.title) || title(terminal?.name);
    const tabTitle = title(tab?.name || a?.tab_name);
    const fallback = title(space?.name || a?.space_name);
    // Keep user-named tabs. In split tabs, each pane's session title distinguishes its agent.
    const name = (tab?.named && tab.panes === 1 ? tabTitle : '') || sessionTitle || tabTitle
      || (fallback ? fallback + ' · ' : '') + kind;
    const evidence = terminal?.status_ms || (tab?.panes === 1 && tab.changed_at) || 0;
    const openAction = a ? 'agent.focus' : pane ? 'pane.focus'
      : terminal?.parent && terminal.program?.agent ? 'agent.focus' : 'terminal.peek';
    rows.push({
      key: address, kind, name, host: host.crest, machineId: host.id, machineName: host.name,
      status: statusOf(a?.status || terminal?.status), activityAt: evidence / 1000, openAction,
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
