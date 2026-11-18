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
