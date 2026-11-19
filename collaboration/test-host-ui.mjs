import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHerdrActions, readHostEntry, teamInvite} from './host-ui.js';

test('host grant is removed from the address bar and from share links', () => {
  const map = new Map();
  const storage = {getItem:key => map.get(key), setItem:(key,value) => map.set(key,value)};
  const entry = readHostEntry(new URL('https://guild.test/#invite=room&owner=private'),storage);
  assert.equal(entry.owner,'private');
  assert.equal(entry.clean.hash,'#invite=room');
  assert.equal(teamInvite(entry.clean,'room'),'https://guild.test/#invite=room');
  assert.equal(readHostEntry(entry.clean,storage).owner,'private');
  assert.equal(readHostEntry(new URL('https://guild.test/#invite=another'),storage).owner,'');
});

test('only the desktop owner gets a chat action, and each action uses the opaque agent id',async () => {
  const calls=[];
  let identity={session:'test',canOpenChats:false};
  const actions=createHerdrActions({session:()=>identity, post:(...args)=>calls.push(args), toast(){}});
  const agent={id:'opaque',name:'Codex mage 1'};
  await actions.chat(agent);
  assert.deepEqual(calls,[]);
  identity={...identity,canOpenChats:true,canOpenWorld:true};
  await actions.chat(agent);
  assert.deepEqual(calls,[['/api/agent-chat',{id:'opaque'},'test']]);
});
