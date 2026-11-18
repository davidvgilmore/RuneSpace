import test from 'node:test';
import assert from 'node:assert/strict';
import {GameKeys} from '../layout/mods/runespace/play-keys.js';

const event=(key,modifiers={},is_held=false)=>({key,modifiers,is_held});

test('the embedded keyboard publishes releases, fast taps and one-shot actions',async()=>{
  let text=null;
  const pad=new GameKeys(async()=>text,async(value,expected)=>{
    assert.equal(text,expected);text=value;
  });
  pad.begin(101);pad.update(event('a'),true);pad.update(event('up'),true);await pad.flush();
  assert.deepEqual(JSON.parse(text).keys,['a','up']);
  pad.update(event('a',{},true),true);pad.update(event('a',{platform:true}),false);
  pad.update(event('s'),true);pad.update(event('s'),false);
  pad.update(event('g'),true);pad.update(event('g',{},true),true);pad.update(event('g'),false);
  pad.update(event('i'),true);pad.update(event('i',{},true),true);pad.update(event('i'),false);
  pad.update(event('+'),true);pad.update(event('-'),true);pad.update(event('w',{platform:true}),true);
  await pad.flush();
  const saved=JSON.parse(text);
  assert.deepEqual(saved.keys,['up']);
  assert.deepEqual(saved.presses,{a:1,up:1,s:1});
  assert.deepEqual(saved.actions.map(a=>[a.kind,a.delta]),[['dance',undefined],['inventory',undefined],['zoom',.12],['zoom',-.12]]);
  assert.ok(saved.actions.every((a,i,all)=>a.at>0&&(!i||a.seq>all[i-1].seq)));
  pad.clear();await pad.flush();
  assert.deepEqual(JSON.parse(text).keys,[]);
  pad.begin(102);await pad.flush();
  assert.equal(JSON.parse(text).entry,102);assert.deepEqual(JSON.parse(text).actions,[]);
});

test('coalesces a release during an asynchronous write and respects a newer entry',async()=>{
  let text=null,release;
  const pad=new GameKeys(async()=>text,async(value,expected)=>{
    if(release===undefined)await new Promise(resolve=>{release=resolve;});
    assert.equal(text,expected);text=value;
  });
  pad.begin(10);pad.update(event('w'),true);const run=pad.flush();
  await new Promise(resolve=>setImmediate(resolve));
  pad.clear();release();await run;
  assert.deepEqual(JSON.parse(text).keys,[]);
  const newer=JSON.stringify({entry:11,seq:1,keys:['d']});text=newer;
  pad.update(event('w'),true);await pad.flush();await pad.flush();
  assert.equal(text,newer);
});
