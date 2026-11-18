import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRoster } from '../layout/mods/runespace/native-roster.js';
import { rosterStatus, IDLE_TIMEOUT_SECONDS as timeout } from '../layout/mods/runespace/roster-presence.js';

const program = { key: 'codex', name: 'Codex', agent: true };
const agent = {address:'t1',space:'space-1',tab:'tab-1',title:'Review the garden plan',status:'idle',program};
const terminal = {address:'t1',state:'live',program,status:'idle'};
const tab = {id:'tab-1',name:'1',named:false,panes:1,changed_at:10000};
const source = {
  agents:[agent],terminals:[terminal],machines:[{name:null,layout:'ready'}],
  spaces:[{id:'space-1',name:'Garden',machine:null,tabs:[tab]}],
};
const sample = (now,previous,data=source) => nativeRoster(data,previous,now);
const first = state => state.agents[0];

test('listed sessions use native addresses, named tabs, individual split titles and public role classes', () => {
  const host='my-laptop';
  const data={...source, machines:[...source.machines,{name:host,layout:'ready'}],
    agents:[agent,{...agent,address:host+'/t1',space:host+'/s1',tab:host+'/a',app:'claude-code'}],
    spaces:[{...source.spaces[0],tabs:[{...tab,named:true,name:'New route'}]},
      {id:host+'/s1',machine:host,tabs:[{...tab,id:host+'/a',named:true,name:'Split tab',panes:2}]}]};
  const d=sample(100,null,data);
  assert.deepEqual(d.agents.map(a=>[a.key,a.kind,a.name,a.machineName,a.openAction]),[
    ['t1','Codex','New route','This computer','agent.focus'],
    [host+'/t1','Claude','Review the garden plan',host,'agent.focus'],
  ]);
  assert.equal(d.agents[0].host,'local');
  assert.notEqual(d.agents[1].machineId,d.agents[0].machineId);
  assert.ok(['remote','other'].includes(d.agents[1].host));
});

test('parked agents and children are addressable while shell and finished terminals stay outside the roster',()=>{
  const data={...source,agents:[],terminals:[
    {...terminal,address:'peer/t2',program:{key:'opencode',agent:true}},
    {...terminal,address:'peer/t3',parent:'peer/t2',program:{key:'hermes',agent:true}},
    {...terminal,address:'t4',program:{key:'shell',agent:false}},
    {...terminal,address:'t5',state:'exited'},
  ]};
  const d=sample(100,null,data);
  assert.deepEqual(d.agents.map(a=>[a.key,a.kind,a.machineName,a.openAction]),[
    ['peer/t2','OpenCode','peer','terminal.peek'],['peer/t3','Hermes','peer','agent.focus'],
  ]);
});

test('fallback names disambiguate duplicate agents and discard machine paths and opaque ids',()=>{
  const a={...agent,title:'01a1ec04'};
  const data={...source,agents:[a,{...a,address:'t2',title:'/home/user/repo'}]};
  const d=sample(100,null,data);
  assert.deepEqual(d.agents.map(a=>a.name),['Garden · Codex · t1','Garden · Codex · t2']);
});

test('idle age survives polls, reloads and title changes; working sessions re-enter immediately',()=>{
  const before=sample(100);
  assert.equal(first(before).lastActivityAt,10);
  assert.equal(rosterStatus(first(sample(10+timeout-1,before))),'idle');
  const offline=sample(10+timeout,JSON.parse(JSON.stringify(before)),{...source,agents:[{...agent,title:'New name'}]});
  assert.equal(first(offline).key,agent.address);
  assert.equal(first(offline).mapVisible,false);
  assert.equal(rosterStatus(first(offline)),'offline');
  const active=sample(3000,offline,{...source,agents:[{...agent,status:'working'}]});
  assert.equal(first(active).mapVisible,true);
  const idle=sample(3004,active,{...source,agents:[{...agent,status:'done'}]});
  assert.equal(first(idle).lastActivityAt,3004);
  assert.equal(first(sample(3004+timeout,idle)).mapVisible,false);
});

test('unreachable machines keep previously known friends without making them clickable or visible',()=>{
  const fresh=sample(100);
  const lost=sample(4000,fresh,{...source,machines:[{name:null,layout:'unavailable'}]});
  assert.equal(rosterStatus(first(lost)),'unknown');
  assert.equal(first(lost).mapVisible,false);
  assert.equal(first(lost).connectionUnavailable,true);
  const restored=sample(4100,lost);
  assert.equal(first(restored).connectionUnavailable,undefined);
  assert.equal(rosterStatus(first(restored)),'offline');
  assert.deepEqual(sample(4300,restored,{...source,agents:[],terminals:[]}).agents,[]);
});

test('first observation starts idle age when Herdr has no timestamps',()=>{
  const data={...source,spaces:[]};
  const fresh=sample(900,null,data);
  assert.equal(first(fresh).lastActivityAt,900);
  assert.equal(rosterStatus(first(sample(900+timeout,fresh,data))),'offline');
});

test('Pi and OpenCode honor reported states across working, blocked, idle, offline, and resumed work', () => {
  for (const [kind, app] of [['Pi', 'pi'], ['OpenCode', 'opencode']]) {
    const address = 'remote/t1';
    let previous;
    const poll = (status, time, statusTime = time) => {
      const report = {app, state: status, title: 'Map the orchard'};
      const program = {key: app, name: kind, agent: true};
      const data = {
        ...source, spaces: [],
        agents: [{...agent, address, app, status, program}],
        terminals: [{...terminal, address, status, report, program, status_ms: statusTime * 1000}],
      };
      previous = sample(time, previous, data);
      assert.equal(previous.agents.length, 1);
      const a = first(previous);
      assert.deepEqual([a.key, a.kind, a.openAction, a.name], [address, kind, 'agent.focus', report.title]);
      return a;
    };
    for (const [time, status] of [[100, 'working'], [110, 'blocked'], [120, 'error'], [130, 'done']]) {
      assert.equal(rosterStatus(poll(status, time)), status === 'done' ? 'idle' : status);
    }
    assert.equal(poll('idle', 130 + timeout, 130).mapVisible, false);
    assert.equal(poll('working', 131 + timeout).mapVisible, true);
  }
});

test('unreported interactive harnesses use their real pane or parked terminal until the first native report', () => {
  const launch = (address, argv) => ({address, state:'live', status:null,
    program:{key:'program', name:'node', agent:false}, foreground:{argv}});
  const terminals = [
    launch('t1', ['node', '/lib/@earendil-works/pi-coding-agent/dist/cli.js', '--offline']),
    launch('peer/t1', ['/bin/opencode', '--server', 'http://localhost', 'mini']),
    launch('t2', ['pi', '--mode', 'rpc']),
    launch('t3', ['opencode', '--log-level', 'info', 'serve']),
    launch('t4', ['opencode', 'web']),
    launch('t5', ['node', '/tool/cli.js', 'pi']),
    launch('t6', ['pi', '-p', 'Summarize']),
    launch('t7', ['pi', 'install', 'extension']),
    launch('t8', ['opencode', 'run', 'Summarize']),
    {...launch('t9', ['/bin/zsh', '-i']), argv:['opencode'], program:{key:'shell', name:'zsh', agent:false}},
    launch('t10', ['opencode', '--prompt', 'serve']),
    launch('t11', ['pig']),
  ];
  const data = {...source, agents:[], terminals, panes:[{terminal:'t1', tab:tab.id}]};
  const before = sample(10, null, data);
  assert.deepEqual(before.agents.map(a=>[a.key, a.kind, a.status, a.openAction]), [
    ['t1','Pi','unknown','pane.focus'], ['peer/t1','OpenCode','unknown','terminal.peek'],
    ['t10','OpenCode','unknown','terminal.peek'],
  ]);
  const piProgram = {key:'pi',name:'Pi',agent:true};
  const reports = {...data, agents:[{...agent, app:'pi',program:piProgram,status:'working'}]};
  const pi = first(sample(20, before, reports));
  assert.deepEqual([pi.key, pi.status, pi.kind, pi.openAction], ['t1','working','Pi','agent.focus']);
  assert.ok(!sample(25, before, {...data, terminals:terminals.slice(1)}).agents.some(a=>a.key==='t1'));
});
