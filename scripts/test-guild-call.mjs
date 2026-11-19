import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const dir = new URL('../layout/mods/runespace/', import.meta.url);
async function load(file, expression, mocks) {
  const js = (await readFile(new URL(file, dir), 'utf8'))
    .replace(/^import .*;$/gm, '').replace(/^export (default )?/gm, '');
  return vm.runInNewContext(js + '\n' + expression, mocks);
}

async function harness() {
  const tasks = [], requests = [], values = new Map();
  const cx = {notify() {}, spawn(task) { tasks.push(task(cx)); }};
  const world = {config: true, state: {}};
  const api = await load('guild-call.js', '({enterGuildCall,send,readState})', {
    View: class {}, checking: () => false, appHome: () => '/example',
    shared: key => values.get(key), setShared: (key, value) => values.set(key, value),
    readTextFile: async path => {
      if (path.endsWith('runespace-team.json')) {
        if (world.config) return '{"url":"https://example.invalid/#owner=private"}';
        throw Error('Room not configured');
      }
      return JSON.stringify(world.state);
    },
    exec: async (_python, args) => { requests.push([...args]); return {code: 0}; },
  });
  async function drain() { while (tasks.length) await Promise.all(tasks.splice(0)); }
  return {cx, world, api, values, requests, drain};
}

test('the local world still opens without a room and joins configured rooms with no device commands', async () => {
  const {cx, world, api, values, requests, drain} = await harness();
  const enter = () => api.enterGuildCall(cx, 'runespace');
  world.config = false;
  enter();
  await drain();
  assert.equal(requests.length, 0);
  world.config = true;
  enter();
  enter();
  await drain();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], ['/example/mods/runespace/play/social.py','start','--app-home','/example']);
  world.state = {connected: true, updatedAt: Date.now() / 1000, mic: true, peers: [{name:'Teammate'}]};
  enter();
  await drain();
  assert.equal(requests.length, 1, 'returning from an agent or inventory preserves the call');
  api.send(cx, 'runespace', 'stop');
  await drain();
  world.state = {};
  enter();
  await drain();
  assert.equal(requests.at(-1)[1], 'stop', 'an explicit leave survives returning to the world');
  api.send(cx, 'runespace', 'start');
  await drain();
  assert.equal(values.get('runespace.callPaused'), false);
  assert.equal(JSON.stringify([...values]).includes('private'), false);
});

test('a stale helper never leaves an active microphone or camera indicator', async () => {
  const {world, api} = await harness();
  world.state = {updatedAt: Date.now() / 1000 - 60, connected: true, mic: true, camera: true};
  assert.deepEqual({...await api.readState()}, {});
});

test('all desktop world shortcuts enter the same embedded world', async () => {
  const GuildHall = await load('main.js', 'GuildHall', {View: class {}});
  const view = new GuildHall(), visited = [];
  view.enterWorld = () => visited.push('world');
  for (const alias of ['world','team-guild','world-classic','world-embedded','world-window']) {
    view.command(alias, {});
  }
  assert.deepEqual(visited, Array(5).fill('world'));
});

test('a teammate can opt into contributing from the Herdr invite form and change that choice in the call', async () => {
  const values = new Map([['runespace.callState',{configured:false}]]), buttons = new Map(), commands = [], tasks = [];
  const cx = {notify(){}, focus_handle:()=>({focus(){}}), spawn(fn){tasks.push(fn(cx));}};
  let config, state, navigated;
  function element() {
    let click;
    const node = new Proxy({}, {get(_,key) {
      if (key === 'id') return id => { buttons.set(id, node); return node; };
      if (key === 'when') return (condition,fn) => { if (condition) fn(node); return node; };
      if (key === 'on_click') return fn => { click = () => fn({},cx); return node; };
      if (key === 'click') return click;
      return () => node;
    }});
    return node;
  }
  const Call = await load('guild-call.js','GuildCall',{
    View:class {},theme:()=>({}),closeOverlay(){},run(name){navigated=name;},Input:{new:element},div:element,h_flex:element,v_flex:element,
    InputState:{new:()=>({on(){},value:()=>'Nyx'})},
    appHome:()=>'/example',shared:k=>values.get(k),setShared:(k,v)=>values.set(k,v),
    readTextFile:async path=>JSON.stringify(path.endsWith('runespace-team.json')?config:state),
    exec:async (_cli,args)=>{
      commands.push([...args]);
      if (args[1]==='join') {
        config={url:'https://guild.example/#invite=only-the-helper-reads-this',name:'Nyx',shareAgents:args.includes('--bring-agents')};
        state={updatedAt:Date.now()/1000,status:'connected',connected:true,mediaConnected:true};
      }
      if (args[1]==='share-off') config.shareAgents=false;
      return {code:0};
    },
  });
  const view=new Call();view.init({mod:'runespace'},cx);
  function render(){buttons.clear();view.render();}
  async function drain(){while(tasks.length)await Promise.all(tasks.splice(0));}
  render();
  assert.ok(buttons.has('call-paste-join'));assert.equal(view.bringAgents,false);
  buttons.get('call-bring-agents').click();render();
  buttons.get('call-paste-join').click();await drain();render();
  assert.equal(navigated,'runespace.world');
  assert.deepEqual(commands[0].slice(-2),['--name=Nyx','--bring-agents']);
  assert.ok(!buttons.has('call-change-guild'));assert.ok(buttons.has('call-share-off'));
  buttons.get('call-share-off').click();await drain();render();
  assert.ok(buttons.has('call-share-on'));assert.deepEqual(commands.map(args=>args[1]),['join','share-off']);
  assert.ok(!JSON.stringify([...values]).includes('only-the-helper-reads-this'));
  values.set('runespace.callState', {...values.get('runespace.callState'), mic:true, cameraPending:true});
  render();
  assert.equal(buttons.get('call-camera').click, undefined, 'waiting for camera consent disables just the camera control');
  assert.equal(typeof buttons.get('call-mic').click, 'function', 'the live microphone can still be muted');
});
