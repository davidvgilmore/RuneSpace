import { View, div, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, theme, shared, setShared, exec, checking, notify, run, spaces, agents, machines, terminals, panes, focused, window as appWindow, setWindowTitle, nextCommand, appHome, readTextFile, writeTextFile, layout } from "herdr";
import GuildWorld from "./world.js";
import GuildInventory from "./inventory.js";
import { GameKeys } from "./play-keys.js";
import { rosterStatus } from "./roster-presence.js";

import { nativeRoster } from "./native-roster.js";
const STATUS = { working: "On a quest", blocked: "Needs you", idle: "At the bank", error: "Trouble", unknown: "Unknown", offline: "Offline" };
const SIGIL = { Claude: "✦", Codex: "⌘", Hermes: "♜", OpenCode: "◇", Pi: "❧" };
function V() { return div().flex().flex_col().items_stretch().justify_start(); }
function snapshot() { return shared("runespace.snapshot") || {agents:[],hosts:[]}; }
function saveCamera(pose) {
  if(!Number.isFinite(pose.yaw)||!Number.isFinite(pose.zoom))return;
  const camera={yaw:pose.yaw,zoom:pose.zoom};
  const pitch=Number.isFinite(pose.pitch)?pose.pitch:shared('runespace.worldCamera')?.pitch;
  if(Number.isFinite(pitch))camera.pitch=pitch;
  setShared('runespace.worldCamera',camera);
}
const isWorld = mode => ['world','metal','play','sound','world-recovery','inventory'].includes(mode);
function gameBlock(node){
  if(node?.id==='runespace-game')return node;
  for(const child of node?.children||[]){const found=gameBlock(child);if(found)return found;}
  return null;
}
const metal = action => exec('/usr/bin/python3',[appHome()+'/mods/runespace/metal/control.py',action,'--app-home',appHome()],{timeout:action==='open'?90000:4000});
function color(s) { const t=theme(); return ({working:t.working,blocked:t.blocked,idle:t.idle,error:t.ansi1,unknown:t.dim})[s] || t.dim; }
function label(text, size=13, c=null) { return div().text_size(size).text_color(c || theme().foreground).child(text); }
function bevel(el, raised=true) { const t=theme(); return el.border(2).border_color(raised?t.border:t.canvas); }
function button(id, title, fn, active=false) { const t=theme(); return bevel(h_flex().id(id).h(30).px(12).items_center().justify_center().bg(active?t.selected:t.raised), !active).text_color(active?t.accent:t.foreground).text_size(13).cursor_pointer().hover(s=>s.bg(t.hover)).on_click(fn).child(title); }
function heading(text, sub=null) { return V().gap(4).child(label(text,22,theme().accent).font_family("Georgia")).when(!!sub,e=>e.child(label(sub,11,theme().muted))); }

export default class GuildHall extends View {
  init(p,cx) {
    this.role=(props()||p||{}).role || "board";
    if(this.role==='board'){
      this.world=cx.new(GuildWorld);
      this.inventory=cx.new(GuildInventory);
    }
    if(checking()) return;
    if(this.role==="header") {
      this.gameFocus=cx.focus_handle();
      const path=appHome()+'/data/runespace-play/held-keys.json';
      this.gameKeys=new GameKeys(()=>readTextFile(path),(text,expected)=>writeTextFile(path,text,expected));
      setWindowTitle("RuneSpace · Herdr");
      cx.spawn(async cx=>{for(;;){this.command(await nextCommand(),cx);cx.notify();}});
      this.refresh(cx);
      cx.timer.every(250,cx=>this.attachGame(cx));
      cx.timer.every(32,cx=>this.pollGameKeys(cx));
      cx.timer.every(4000,cx=>this.refresh(cx));
    }
    if(this.role==="board") {
      cx.timer.every(350,cx=>this.pollWorld(cx));
    }
  }
  command(c,cx) {
    if(c.startsWith("select:"))this.select(c.slice(7));
    if(c.startsWith("filter:") && (c.slice(7)==="all" || snapshot().hosts.some(h=>h.id===c.slice(7))))setShared("runespace.filter",c.slice(7));
    if(c==="overview")this.overview();if(c==="friends")this.toggleFriends();if(c==="refresh")this.refresh(cx);
    if(c==='world')this.enterWorld(cx);
    if(c==='world-embedded')this.enterWorld(cx);
    if(c==='world-classic')this.embedded();
    if(c==='world-window')this.openWindow(cx);
    if(c==='inventory')this.openInventory(cx);
    if(c==='music')this.openMusic(cx);
    if(c==='inventory-back'&&shared('runespace.mode')==='inventory')this.leaveInventory(cx);
    if(c==='world-benchmark'&&shared('runespace.mode')==='play')setShared('runespace.playBenchmark',{id:Date.now()});
    if(c==='dance'&&['play','metal','world'].includes(shared('runespace.mode')))setShared('runespace.worldCommand',{id:Date.now(),kind:'dance'});
    if(c.startsWith('walk:')){const [x,z]=c.slice(5).split(',').map(Number);if(Number.isFinite(x)&&Number.isFinite(z))setShared('runespace.worldCommand',{id:Date.now(),kind:'walk',x,z});}
    if(c.startsWith('talk:'))setShared('runespace.worldCommand',{id:Date.now(),kind:'talk',key:c.slice(5)});
    if(c.startsWith('orbit:')||c.startsWith('tilt:')){
      const [kind,value]=c.split(':');const delta=Number(value);
      if(Number.isFinite(delta))setShared('runespace.worldCommand',{id:Date.now(),kind,delta});
    }
    if(c==='world-home'||c==='world-report')setShared('runespace.worldCommand',{id:Date.now(),kind:c==='world-home'?'home':'report'});
  }
  async close() {
    if(this.gameKeys){this.gameKeys.clear();await this.gameKeys.flush();}
    if(this.role==='header'&&!checking())await Promise.all([
      exec('/usr/bin/python3',[appHome()+'/mods/runespace/music/control.py','stop','--app-home',appHome()],{timeout:2000}),
      metal('stop')
    ]);
  }
  refresh(cx) {
    try {
      const d=nativeRoster({agents:agents(), terminals:terminals(), spaces:spaces(), machines:machines(), panes:panes()},snapshot());
      setShared('runespace.snapshot',d);
      if(shared('runespace.error'))setShared('runespace.error','');
    } catch(error) {
      setShared('runespace.error',String(error));
    }
    cx.notify();
  }
  current() {
    const list=snapshot().agents;
    return list.find(a=>a.key===shared('runespace.selected')) || list.find(a=>a.status==='blocked') || list[0];
  }
  openMusic(cx) {
    if(this.openingMusic)return;
    this.openingMusic=true;
    cx.spawn(async () => {
      try {
        const result=await exec('/usr/bin/python3',[appHome()+'/mods/runespace/music/control.py',
          'open','--app-home',appHome()],{timeout:90000});
        if(result.code!==0)throw Error(result.stderr||result.stdout||'Please try again.');
      } catch(error) {
        notify({title:'The soundtrack player could not open',body:String(error).slice(-280),level:'error'});
      } finally {this.openingMusic=false;}
    });
  }
  show(mode) {
    if(shared('runespace.mode')==='metal'&&mode!=='metal')metal('stop').catch(()=>{});
    setShared("runespace.mode",mode);
    run("layout.select",{stack:"main-stack",child:mode==='conversation'?'terminals':isWorld(mode)?'ledger':mode});
  }
  focus(on) {
    setShared("runespace.sessionFocus",on);setShared("runespace.friendsOpen",!on);
    run(on?"layout.hide":"layout.show",{id:"sidebar"});
    run("layout.resize",{id:"runespace-header",px:on?48:80});
    run("layout.resize",{id:"runespace-footer",px:on?22:30});
  }
  select(key) {
    const a=snapshot().agents.find(agent=>agent.key===key);
    if(!a || a.connectionUnavailable)return;
    setShared('runespace.fromWorld',isWorld(shared('runespace.mode')) || shared('runespace.mode')==='conversation' && shared('runespace.fromWorld')===true);
    setShared('runespace.selected',key);
    this.focus(true);
    this.show('conversation');
    run(a.openAction,{terminal:key});
  }
  openInventory(cx) {
    const mode=shared('runespace.mode')||'ledger';
    if(mode==='inventory'){this.leaveInventory(cx);return;}
    // Let a running renderer save the exact camera and position it is showing.
    if(mode==='world'||mode==='metal'||mode==='play'&&shared('runespace.playTerminal')){
      setShared('runespace.worldCommand',{id:Date.now(),kind:'inventory'});
      return;
    }
    this.showInventory(mode);
  }
  showInventory(origin) {
    setShared('runespace.inventoryOrigin',origin);
    this.show('inventory');
  }
  leaveInventory(cx) {
    const origin=shared('runespace.inventoryOrigin');
    if(origin==='play')this.enterWorld(cx);
    else if(origin==='metal')this.openWindow(cx);
    else if(origin==='world')this.embedded();
    else this.show(['sound','terminals','conversation'].includes(origin)?origin:'ledger');
  }
  enterWorld(cx) {
    if(this.startingGame)return;
    this.focus(true);
    const since=Date.now();
    setShared('runespace.playTerminal',null);this.show('play');setShared('runespace.metalSince',since);
    setShared('runespace.metalState','Entering the Guild Green…');this.startingGame=true;
    cx.spawn(async cx=>{
      try {
        const result=await exec('/usr/bin/python3',[appHome()+'/mods/runespace/play/launch.py','--app-home',appHome(),'--entry',String(since)],{timeout:90000});
        const data=JSON.parse(result.stdout);
        if(result.code!==0||!data.terminal)throw Error(data.error||result.stderr||'Could not open the game.');
        if(shared('runespace.mode')!=='play'||shared('runespace.metalSince')!==since)return;
        setShared('runespace.playTerminal',data.terminal);
        this.attachGame(cx);
      } catch (err) {
        if(shared('runespace.mode')==='play'&&shared('runespace.metalSince')===since&&!shared('runespace.playTerminal')){
          this.show('world-recovery');setShared('runespace.metalState','The embedded game could not open. '+String(err).slice(-220));
        }
      } finally {this.startingGame=false;cx.notify();}
    });
  }
  attachGame(cx) {
    if(shared('runespace.mode')!=='play')return;
    const terminal=shared('runespace.playTerminal'),entry=shared('runespace.metalSince');
    if(!entry||entry===this.attachedEntry)return;
    if(!terminal){
      if(this.readingEntry)return;
      this.readingEntry=true;
      cx.spawn(async cx=>{
        try {
          const raw=await readTextFile(appHome()+'/data/runespace-play/accepted-entry.json').catch(()=>null);
          const accepted=raw&&JSON.parse(raw);
          if(accepted?.entry===entry&&shared('runespace.mode')==='play'&&shared('runespace.metalSince')===entry
            &&accepted.terminal&&gameBlock(layout())?.content?.terminal===accepted.terminal){
            setShared('runespace.playTerminal',accepted.terminal);
            this.attachGame(cx);
          }
        } finally {this.readingEntry=false;}
      });
      return;
    }
    if(gameBlock(layout())?.content?.terminal!==terminal)return;
    this.attachedEntry=entry;
    run('layout.select',{stack:'main-stack',child:'runespace-game'});
    run('pane.focus',{terminal});
  }
  gameCanFocus(entry){
    if(!entry||shared('runespace.mode')!=='play'||entry!==shared('runespace.metalSince')||!appWindow().active)return false;
    const target=focused();
    return !!target&&target.pane===null&&!!target.terminal&&target.terminal===shared('runespace.playTerminal');
  }
  pollGameKeys(cx){
    const keys=this.gameKeys;
    const play=shared('runespace.mode')==='play',entry=play&&shared('runespace.metalSince');
    if(entry&&this.gameFocus.is_focused()&&appWindow().active){
      keys.begin(entry);keys.heartbeat();
    }else{
      keys.clear();
      if(entry&&!this.claimingGameKeys&&Date.now()>=(this.recheckGameKeys||0)&&this.gameCanFocus(entry)){
        // A Herdr popup can leave the underlying terminal selected while it owns
        // the keyboard. Check the actual surface only when reacquiring focus.
        this.claimingGameKeys=true;this.recheckGameKeys=Date.now()+400;
        cx.spawn(async cx=>{
          try{
            const result=await exec('/usr/bin/python3',[appHome()+'/mods/runespace/herdr_cli.py','status'],{timeout:1500});
            const ui=result.code===0&&JSON.parse(result.stdout);
            if(ui?.layout==='runespace'&&ui.focused_pane==='runespace-game'&&ui.overlays?.length===0&&this.gameCanFocus(entry)){
              this.gameFocus.focus();this.recheckGameKeys=0;keys.begin(entry);await keys.flush();
            }
          }catch(_){}finally{this.claimingGameKeys=false;}
        });
      }
    }
    if(keys.pending&&!keys.writing)cx.spawn(async()=>{await keys.flush();});
  }
  playKey(event,cx,down){
    if(!this.gameFocus?.is_focused()||shared('runespace.mode')!=='play'||!appWindow().active)return;
    const entry=shared('runespace.metalSince');
    if(!entry||!shared('runespace.playTerminal'))return;
    this.gameKeys.begin(entry);
    if(this.gameKeys.update(event,down)){
      cx.stop_propagation();cx.spawn(async()=>{await this.gameKeys.flush();});
    }
  }
  openWindow(cx) {
    if(this.launching)return;
    this.focus(true);this.show('metal');
    const since=Date.now();
    setShared('runespace.metalSince',since);setShared('runespace.metalState','Opening the game window…');this.launching=true;
    cx.spawn(async cx=>{
      try {
        const result=await metal('open');
        if(result.code!==0)throw Error(result.stderr||result.stdout||'The game window could not open.');
        if(shared('runespace.mode')!=='metal'){await metal('stop');return;}
        setShared('runespace.metalState','The game window is open.');
      } catch (err) {
        if(shared('runespace.mode')==='metal')setShared('runespace.metalState','Game window unavailable. '+String(err).slice(-260));
      } finally {this.launching=false;cx.notify();}
    });
  }
  embedded() { this.focus(true);this.show('world'); }
  pollWorld(cx) {
    if(!['metal','play'].includes(shared('runespace.mode'))||this.checkingEvent)return;
    this.checkingEvent=true;
    cx.spawn(async cx=>{
      try {
        if(shared('runespace.mode')==='play'&&Date.now()-(this.poseCheck||0)>2100){
          this.poseCheck=Date.now();
          const rawPose=await readTextFile(appHome()+'/data/runespace-play-position.json').catch(()=>null);
          const p=rawPose&&JSON.parse(rawPose);
          if(p&&p.at>=(shared('runespace.metalSince')||0)&&p.at!==this.poseAt){
            this.poseAt=p.at;setShared('runespace.worldPosition',{x:p.x,z:p.z});saveCamera(p);
          }
        }
        const raw=await readTextFile(appHome()+'/data/runespace-metal-event.json');
        if(!raw||!['metal','play'].includes(shared('runespace.mode')))return;
        const event=JSON.parse(raw);
        if(!(event.id>=(shared('runespace.metalSince')||0))||event.id===this.lastEvent)return;
        this.lastEvent=event.id;
        if(Number.isFinite(event.x)&&Number.isFinite(event.z))setShared('runespace.worldPosition',{x:event.x,z:event.z});
        saveCamera(event);
        if(event.kind==='report'&&event.report){
          setShared('runespace.worldReport',event.report);
        } else if(event.kind==='chat'){
          const agent=snapshot().agents.find(a=>a.key===event.key);
          if(agent && !agent.connectionUnavailable)this.select(agent.key);
          else this.overview();
        } else if(event.kind==='play-error') {
          this.show('world-recovery');setShared('runespace.metalState','The embedded game stopped. Choose Guild world to reconnect.');
        } else if(event.kind==='inventory') {
          this.showInventory(shared('runespace.mode'));
        } else if(event.kind==='music') {
          this.openMusic(cx);
        } else if(event.kind==='back') {
          this.overview();
        }
        cx.notify();
      } catch (_) {
        // A fresh installation has no return event until the first window closes.
      } finally {this.checkingEvent=false;}
    });
  }
  overview() { this.focus(false);this.show("ledger"); }
  toggleFriends() {
    const open=!shared("runespace.friendsOpen");setShared("runespace.friendsOpen",open);
    run(open?"layout.show":"layout.hide",{id:"sidebar"});
  }
  header() {
    const t=theme(),d=snapshot(),working=d.agents.filter(a=>rosterStatus(a)==="working").length;
    if(shared("runespace.sessionFocus"))return h_flex().size_full().bg(t.chrome).px(14).gap(12).items_center()
      .child(div().w(70).flex_shrink_0())
      .child(label("♜  RuneSpace",18,t.accent).font_family("Georgia"))
      .child(div().flex_1())
      .child(button('world-nav',isWorld(shared('runespace.mode'))?'Guild world':shared('runespace.fromWorld')?'← Guild world':'Guild world',(_e,cx)=>this.enterWorld(cx),isWorld(shared('runespace.mode'))))
      .when(isWorld(shared('runespace.mode')),e=>e.child(button('inventory-nav','Inventory',(_e,cx)=>this.openInventory(cx),shared('runespace.mode')==='inventory')))
      .child(button('music-nav','♫ Music',(_e,cx)=>this.openMusic(cx)))
      .when(isWorld(shared('runespace.mode')),e=>e.child(button('window-nav','Pop out',(_e,cx)=>this.openWindow(cx))))
      .child(button("friends-nav",shared("runespace.friendsOpen")?"Hide friends":"Friends list",()=>this.toggleFriends(),shared("runespace.friendsOpen")))
      .child(button("ledger-nav","Guild overview",()=>this.overview()))
      .child(button("term-nav","Terminals",()=>this.show("terminals"),shared("runespace.mode")==="terminals"));
    return bevel(h_flex().size_full().bg(t.chrome).px(20).gap(18).items_center())
      .child(div().w(62))
      .child(bevel(h_flex().w(48).h(48).items_center().justify_center().bg(t.selected)).child(label("♜",32,t.accent)))
      .child(V().gap(2).child(label("RuneSpace",27,t.accent).font_family("Georgia"))
        .child(label("The Agents' Guild",12,t.muted)))
      .child(div().flex_1())
      .child(V().items_end().gap(3).child(label(working+" on a quest",14,t.working)).child(label(d.agents.length+" in the Friends list",11,t.muted)))
      .child(button('world-nav','Guild world',(_e,cx)=>this.enterWorld(cx)))
      .child(button('inventory-nav','Inventory',(_e,cx)=>this.openInventory(cx),shared('runespace.mode')==='inventory'))
      .child(button("ledger-nav","Guild ledger",()=>this.overview(),shared("runespace.mode")!=="terminals"))
      .child(button("term-nav","Terminals",()=>this.show("terminals"),shared("runespace.mode")==="terminals"))
      .child(button("settings-nav","⚙",()=>run("app.settings")));
  }
  sidebar() {
    const t=theme(),d=snapshot();
    const filters=[{id:'all',name:'All worlds'},...d.hosts];
    const filter=filters.find(f=>f.id===shared('runespace.filter')) || filters[0];
    const items=d.agents.filter(a=>filter.id==='all'||a.machineId===filter.id)
      .sort((a,b)=>Number(rosterStatus(a)==='offline')-Number(rosterStatus(b)==='offline') || a.name.localeCompare(b.name));
    return V().id('company').size_full().min_h(0).bg(t.chrome).p(12).gap(10)
      .child(heading('Friends list'))
      .when(filters.length>2,e=>e.child(button('world-filter',filter.name+'  ›',()=>{
        const next=(filters.indexOf(filter)+1)%filters.length;setShared('runespace.filter',filters[next].id);
      })))
      .child(div().h(2).bg(t.border))
      .child(V().id('roster-scroll').flex_1().min_h(0).overflow_y_scrollbar().gap(4)
        .when(!items.length,e=>e.child(label(d.at?'No agents in this world.':'Reading Herdr agents…',12,t.muted)))
        .children(items.map(a=>{
          const selected=shared('runespace.selected')===a.key;
          return bevel(V().id('friend-'+a.key).p(9).gap(4).bg(selected?t.selected:t.surface),!selected)
            .when(!a.connectionUnavailable,e=>e.cursor_pointer().hover(s=>s.bg(t.hover)).on_click(()=>this.select(a.key)))
            .child(h_flex().gap(7).items_center().child(label(SIGIL[a.kind]||'◆',16,t.accent))
              .child(label(a.name,13,selected?t.accent:t.foreground).font_family('Geist').line_height(1.3).flex_1().min_w(0)))
            .child(h_flex().gap(6).items_center()
              .child(label(a.machineName+' / '+a.kind,10,t.muted).flex_1().min_w(0).truncate())
              .child(label('● '+STATUS[rosterStatus(a)],10,color(rosterStatus(a)))));
        })))
      .child(label('Offline after 30 minutes idle',11,t.muted))
      .child(button('new-native','+ New terminal',()=>{run('tab.new');this.show('terminals');}));
  }
  map() {
    const t=theme(),d=snapshot();
    return V().id('world-scroll').w(246).h_full().min_h(0).overflow_y_scrollbar().flex_shrink_0().gap(12)
      .child(bevel(V().bg(t.surface).p(10).gap(8))
        .child(heading('World map'))
        .child(image('mods/runespace/world-map.svg').w(222).h(184))
        .children(d.hosts.map(h=>{
          const count=d.agents.filter(a=>a.machineId===h.id).length;
          return h_flex().id('world-'+h.id).gap(6).cursor_pointer().on_click(()=>setShared('runespace.filter',h.id))
            .child(label('◆',11,h.online?t.working:t.muted)).child(label(h.name,12).flex_1().min_w(0).truncate()).child(label(String(count),12,t.accent));
        })))
      .child(bevel(V().bg(t.surface).p(12).gap(8))
        .child(heading('Quick travel'))
        .children(spaces().map(s=>button('travel-'+s.id,s.name,()=>{run('space.select',{id:s.id});this.show('terminals');}))));
  }
  board() {
    if(shared('runespace.mode')==='inventory')return this.inventory;
    if(isWorld(shared('runespace.mode')))return this.world;
    const t=theme(),a=this.current(),d=snapshot();
    return h_flex().size_full().min_h(0).items_start().p(14).gap(14).bg(t.canvas)
      .child(V().flex_1().h_full().min_w(0).min_h(0).gap(12)
        .child(bevel(V().bg(t.surface).p(18).gap(10))
          .child(heading('Guild ledger'))
          .child(h_flex().gap(8).children([['working','On a quest'],['blocked','Needs you'],['idle','At the bank']].map(([s,title])=>
            bevel(V().flex_1().p(10).bg(t.background),false).child(label(String(d.agents.filter(a=>rosterStatus(a)===s).length),25,color(s))).child(label(title,12,t.muted))))))
        .child(bevel(V().bg(t.surface).p(16).gap(12))
          .child(heading(a?a.name:'Gather your company'))
          .child(label(a?a.machineName+'  /  '+a.kind+'  ·  '+STATUS[rosterStatus(a)]:'Start an agent in a Herdr terminal to see it here.',13,t.foreground))
          .when(!!a && !a.connectionUnavailable,e=>e.child(button('open-session','Open conversation →',()=>this.select(a.key))))
          .when(!!a?.connectionUnavailable,e=>e.child(label('Waiting for this machine to reconnect.',12,t.muted))))
        .child(bevel(V().bg(t.surface).p(16).gap(10))
          .child(heading('Guild Green'))
          .child(label('Walk up to a companion to open their terminal. Idle companions gather around the fire.',13,t.muted))
          .child(h_flex().gap(7).flex_wrap().child(button('enter-green','Enter the world',(_e,cx)=>this.enterWorld(cx)))
            .child(button('ledger-music','♫ Music',(_e,cx)=>this.openMusic(cx))))))
      .child(this.map());
  }
  footer() {
    const t=theme(),d=snapshot(),age=d.at?Date.now()/1000-d.at:null,error=shared('runespace.error');
    const unavailable=d.hosts.filter(h=>!h.online);
    const summary=error?'Roster unavailable':unavailable.length?'Waiting for '+unavailable.map(h=>h.name).join(', ')
      :d.hosts.map(h=>h.name).join(' · ') || 'Connecting…';
    return h_flex().size_full().bg(t.chrome).px(14).items_center().gap(12)
      .child(label('●',11,error||unavailable.length?t.blocked:t.working))
      .child(label(summary,11,t.muted).flex_1().min_w(0).truncate())
      .child(label(age===null?'Connecting…':age>35?'Awaiting roster update':'Live roster',11,age>35?t.blocked:t.muted))
      .child(label('⌘⇧P  Commands',11,t.accent));
  }
  render() {
    if(this.role==='header'){
      const header=this.header();
      if(!this.gameFocus||shared('runespace.mode')!=='play')return header;
      return header.track_focus(this.gameFocus).key_context('GuildPlay')
        .on_key_down((e,cx)=>this.playKey(e,cx,true)).on_key_up((e,cx)=>this.playKey(e,cx,false));
    }
    return this.role==='sidebar'?this.sidebar():this.role==='footer'?this.footer():this.board();
  }
}
