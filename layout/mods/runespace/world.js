import {View,div,PathBuilder} from 'gpui-kit';
import {h_flex} from 'gpui-base';
import {shared,setShared,checking,run,exec,appHome,readTextFile} from 'herdr';
import {Simulation,Camera,Mesh,character,ACTIVITY,HOST_COLOR,clipFor,poseFor,animationPhase,clamp,clampPitch,DEFAULT_PITCH,distance,TAU,mergeAdventureProgress} from './world-engine.js';
import {packFaces,sameFaces} from './world-packing.js';
import {normalizeLoadout} from './equipment.js';
import {buildAdventureModel} from './world-art.js';

const V=()=>div().flex().flex_col().items_stretch().justify_start();
const text=(s,size=13,c='#e9dfbf')=>div().text_size(size).text_color(c).child(s);
const button=(id,s,fn,active=false)=>h_flex().id(id).h(29).px(10).items_center().justify_center().bg(active?'#4d5937':'#403f31').border(1).border_color('#8e8059').cursor_pointer().hover(e=>e.bg('#5b5d3f')).on_click(fn).child(text(s,12,active?'#ffe289':'#e8d9b1'));
const panel=()=>V().bg('#272a21ee').border(2).border_color('#817656').p(12).gap(5);
const statusColor=s=>s==='working'?'#bdd48c':s==='blocked'||s==='error'?'#f3b36e':s==='unknown'?'#aaaa95':'#ddc680';
const elevationOf=p=>p.x>-18.8&&p.x<-13.3&&p.z>1.9&&p.z<4.1?.43:0;
const adventureAction=p=>p.activity==='stump'?'Oak stump':(p.kind==='oak'?'Chop down ':'Attack ')+p.name;

// Each retained layer has a bounded render. Native geometry is immutable and reusable;
// element descriptions are rebuilt for every pass, as GPUI requires.
const scenes=new Map();let sceneId=0;
class SceneBatch extends View {
  init(p){this.scene=p.scene;this.index=p.index;this.paths=new WeakMap();}
  render(){
    const groups=scenes.get(this.scene)?.get(this.index)||[],root=div().absolute().inset(0).size_full();
    for(const g of groups){
      let cached=this.paths.get(g.faces[0]);
      if(!cached||!sameFaces(cached.faces,g.faces)){
        const path=PathBuilder.fill();for(const f of g.faces)path.add_polygon(f.points,true);
        cached={faces:g.faces,path:path.build()};this.paths.set(g.faces[0],cached);
      }
      root.child(window.paint_path(cached.path,g.color).absolute().inset(0).size_full());
    }
    return root;
  }
}

export default class GuildWorld extends View {
  init(_p,cx){
    this.sim=new Simulation();this.width=1000;this.height=650;this.restoreCamera();
    this.focus=cx.focus_handle();this.keys={};this.hover=null;this.names=false;this.hint='Welcome to the Guild Green.';
    this.last=Date.now();this.entered=false;this.commandId=shared('runespace.worldCommand')?.id||null;this.frames=0;this.fps=20;this.fpsAt=Date.now();
    this.follow={x:0,z:2};this.camera=new Camera(this.width,this.height,this.follow,this.yaw,this.zoom,this.pitch);this.meshCamera=new Camera(this.width,this.height,{x:0,z:0},this.yaw,this.zoom,this.pitch);
    this.projected=[];this.drag=null;this.renderTime=0;
    this.poses=new Map();this.actors=new Map();this.groundActors=new Map();this.staticProjection=null;this.staticCamera='';
    this.adventureMeshes=new Map();
    this.adventurePath=appHome()+'/data/runespace-adventure.json';
    this.visit=0;
    this.scene=++sceneId;scenes.set(this.scene,new Map());this.layers=[];this.bandCache=new Map();this.bandLayers=new Map();
    const saved=shared('runespace.worldPosition');if(saved&&!this.sim.blocked(saved.x,saved.z)){this.sim.player.x=saved.x;this.sim.player.z=saved.z;}
    this.follow={x:this.sim.player.x*.60,z:this.sim.player.z*.45-3};
    if(checking())return;
    // This clock advances the walking simulation. Hidden worlds do no rendering or simulation work.
    cx.timer.every(16,cx=>this.tick(cx));
  }
  restoreCamera(){
    const camera=shared('runespace.worldCamera');
    this.yaw=camera?.yaw??.18;this.zoom=clamp(camera?.zoom??1.13,.75,1.9);this.pitch=clampPitch(camera?.pitch);
  }
  saveCamera(){
    const camera=shared('runespace.worldCamera');
    if(camera?.yaw!==this.yaw||camera?.zoom!==this.zoom||camera?.pitch!==this.pitch)
      setShared('runespace.worldCamera',{yaw:this.yaw,zoom:this.zoom,pitch:this.pitch});
  }
  loadAdventure(cx) {
    if(this.adventureIO)return;
    this.adventureIO=true;
    const visit=this.visit;
    cx.spawn(async cx=>{
      try {
        const raw=await readTextFile(this.adventurePath);
        if(visit!==this.visit||shared('runespace.mode')!=='world')return;
        this.adventureFile=raw??null;
        this.sim.restoreAdventure(raw?JSON.parse(raw):null);
        this.savedRevision=this.sim.adventure.revision;
        this.progressReady=true;
      } catch(_) {
        this.hint='Could not load adventure progress.';
        this.retryAt=Date.now()+2000;
      } finally {this.adventureIO=false;cx.notify();}
    });
  }
  saveAdventure(cx) {
    if(!this.progressReady||this.adventureIO||this.sim.adventure.revision===this.savedRevision||Date.now()<(this.retryAt||0))return;
    this.adventureIO=true;
    cx.spawn(async ()=>{
      try {
        const home=appHome(),script=home+'/mods/runespace/play/adventure_store.py';
        for(let attempt=0;attempt<4&&this.sim.adventure.revision!==this.savedRevision;attempt++){
          const revision=this.sim.adventure.revision;
          const value=JSON.stringify(this.sim.saveAdventure());
          const request=JSON.stringify({expected:this.adventureFile,value});
          const result=await exec('/usr/bin/python3',[script,home,request],{timeout:2500});
          if(result.code!==0)throw Error('Adventure save failed');
          const reply=JSON.parse(result.stdout);
          if(reply.ok){
            this.adventureFile=value;this.savedRevision=revision;
          }else{
            const base=JSON.parse(this.adventureFile),current=JSON.parse(reply.current);
            const merged=mergeAdventureProgress(base,this.sim.saveAdventure(),current);
            this.sim.reconcileAdventure(merged);
            this.adventureFile=reply.current;
          }
        }
      } catch(_) {
        this.hint='Retrying adventure save…';this.retryAt=Date.now()+1000;
      } finally {this.adventureIO=false;}
    });
  }
  tick(cx){
    const now=Date.now(),dt=Math.min(.1,(now-this.last)/1000);this.last=now;
    if(shared('runespace.mode')!=='world'){
      if(this.entered){this.saveCamera();this.sim.stopDance();this.sim.cancelAdventure();this.visit++;}
      this.saveAdventure(cx);
      this.keys={};this.drag=null;this.entered=false;return;
    }
    if(!this.entered){
      this.entered=true;this.focus.focus();
      this.progressReady=false;this.retryAt=0;
      this.sim.player.loadout=normalizeLoadout(shared('runespace.loadout'));
      this.gearKey=Object.values(this.sim.player.loadout).join('/');
      const saved=shared('runespace.worldPosition');
      if(saved&&!this.sim.blocked(saved.x,saved.z)){Object.assign(this.sim.player,saved);this.sim.path=[];this.sim.targetKey=null;}
      this.restoreCamera();
      this.follow={x:this.sim.player.x*.60,z:this.sim.player.z*.45-3};
    }
    if(!this.progressReady&&now>=(this.retryAt||0))this.loadAdventure(cx);
    if(!this.focus.is_focused())this.keys={};
    const snap=shared('runespace.snapshot')||{agents:[]},stale=!snap.at||now/1000-snap.at>35;
    this.sim.sync(snap.agents,stale);
    if(this.cacheRevision!==this.sim.revision){
      this.cacheRevision=this.sim.revision;
      for(const key of this.poses.keys())if(key!==this.sim.player.key&&!this.sim.npcs.has(key)){
        this.poses.delete(key);this.actors.delete(key);this.groundActors.delete(key);
      }
    }
    const command=shared('runespace.worldCommand');
    if(command&&command.id!==this.commandId){
      this.commandId=command.id;
      if(command.kind==='inventory'){this.openInventory();return;}
      if(command.kind==='walk')this.walk({x:command.x,z:command.z});
      if(command.kind==='talk')this.talk(command.key);
      if(command.kind==='interact')this.interact(command.key);
      if(command.kind==='orbit')this.yaw+=command.delta;
      if(command.kind==='tilt')this.pitch=clampPitch(this.pitch+command.delta);
      if(command.kind==='home')this.home();
      if(command.kind==='dance')this.dance();
      if(command.kind==='report')this.report();
    }
    const keys=this.keys;
    this.yaw+=((keys.d||keys.e?1:0)-(keys.a||keys.q?1:0))*dt*.9;
    this.pitch=clampPitch(this.pitch+((keys.w||keys.r?1:0)-(keys.s||keys.f?1:0))*dt*.85);
    this.sim.step(dt,this.keys,this.yaw);
    this.saveAdventure(cx);
    if(now-(this.lastSave||0)>2500){
      const saved=shared('runespace.worldPosition');this.lastSave=now;
      if(!saved||Math.abs(saved.x-this.sim.player.x)+Math.abs(saved.z-this.sim.player.z)>.1)setShared('runespace.worldPosition',{x:this.sim.player.x,z:this.sim.player.z});
      this.saveCamera();
    }
    this.follow.x=this.sim.player.x*.60;
    this.follow.z=this.sim.player.z*.45-3;
    if(this.sim.arrived){const key=this.sim.arrived;this.sim.arrived=null;this.openChat(key);return;}
    this.frames++;if(now-this.fpsAt>2500){this.fps=Math.round(this.frames*1000/(now-this.fpsAt));this.frames=0;this.fpsAt=now;}
    const started=Date.now();this.camera=new Camera(this.width,this.height,this.follow,this.yaw,this.zoom,this.pitch);
    const signature=[this.width,this.height,this.yaw,this.zoom,this.pitch,Math.floor(this.sim.time*12),this.hover,this.sim.targetKey,this.sim.revision,
      this.sim.player.x,this.sim.player.z,this.sim.player.yaw,...[...this.sim.npcs.values()].filter(p=>p.moving).map(p=>p.key+':'+p.x+':'+p.z)].join('|');
    if(signature===this.frameSignature)return;
    this.frameSignature=signature;
    this.meshCamera=new Camera(this.width,this.height,{x:0,z:0},this.yaw,this.zoom,this.pitch);
    const faces=this.projectScene(),bands=new Map(),scene=scenes.get(this.scene),layers=[];this.faceCount=faces.length;this.pathCount=0;this.dirtyLayers=0;
    // Fixed depth bands preserve painter order while isolating animated parts.
    for(const f of faces){const key=f.ground?'g'+f.top:'d'+Math.floor(f.depth/3);if(!bands.has(key))bands.set(key,[]);bands.get(key).push(f);}
    for(const [key,band] of bands){
      let cached=this.bandCache.get(key);
      if(!cached||!sameFaces(cached.faces,band)){
        cached={faces:band,groups:packFaces(band,this.width,this.height)};this.bandCache.set(key,cached);
      }
      this.pathCount+=cached.groups.length;
      for(let i=0;i<cached.groups.length;i+=64){
        const id=key+'/'+i,groups=cached.groups.slice(i,i+64),before=scene.get(id)||[];
        let layer=this.bandLayers.get(id);if(!layer){layer=cx.new(SceneBatch,{scene:this.scene,index:id});this.bandLayers.set(id,layer);}
        if(before.length!==groups.length||groups.some((g,j)=>!sameFaces(g.faces,before[j].faces))){scene.set(id,groups);cx.notify(layer);this.dirtyLayers++;}
        layers.push(layer);
      }
    }
    this.layers=layers;this.renderTime=Date.now()-started;
    cx.notify();
  }
  report(){setShared('runespace.worldReport',{player:{x:this.sim.player.x,z:this.sim.player.z,activity:poseFor(this.sim.player)},walking:this.sim.path.length,target:this.sim.targetKey,
    adventure:{...this.sim.saveAdventure(),targetKey:this.sim.adventure.targetKey,entities:this.sim.adventure.entities.map(({key,kind,activity,hp,x,z})=>({key,kind,activity,hp,x,z}))},
    nearest:this.sim.nearest()?.key||null,npcs:[...this.sim.npcs.values()].map(p=>({key:p.key,name:p.name,x:p.x,z:p.z,status:p.status,activity:p.activity,moving:p.moving})),
    faces:this.faceCount||0,paths:this.pathCount||0,dirtyLayers:this.dirtyLayers,renderMs:this.renderTime,simulationHz:this.fps,width:this.width,height:this.height,yaw:this.yaw,zoom:this.zoom,pitch:this.pitch,at:Date.now()});}
  openChat(key){
    if(!this.sim.npcs.has(key))return;
    setShared('runespace.worldPosition',{x:this.sim.player.x,z:this.sim.player.z});
    this.saveCamera();
    run('runespace.select:'+key);
    this.keys={};this.hint='Conversation opened. Your place in the world is saved.';
  }
  walk(p){
    this.hint=this.sim.walk(p)?'Walking…':'You cannot walk there.';this.focus.focus();
  }
  talk(key){
    const p=this.sim.npcs.get(key);if(!p)return;
    this.sim.approach(key);this.hint='Walking over to '+p.name+'…';this.focus.focus();
  }
  interact(key){
    if(this.progressReady)this.sim.interact(key);
    this.focus.focus();
  }
  home(){this.zoom=1.13;this.yaw=.18;this.pitch=DEFAULT_PITCH;this.walk({x:0,z:10.5});}
  dance(){this.sim.dance();this.focus.focus();}
  openInventory(){
    this.saveCamera();
    setShared('runespace.worldPosition',{x:this.sim.player.x,z:this.sim.player.z});
    setShared('runespace.inventoryOrigin','world');
    setShared('runespace.mode','inventory');
  }
  key(e,cx,down){
    const key=e.key.toLowerCase();
    if(down&&(e.modifiers.platform||e.modifiers.control||e.modifiers.alt))return;
    if(['w','a','s','d','q','e','r','f','up','down','left','right'].includes(key)){this.keys[key]=down;cx.stop_propagation();}
    if(key==='g'){
      if(down&&!this.keys.g)this.dance();
      this.keys.g=down;cx.stop_propagation();
    }
    if(!down)return;
    if(key==='m'){if(!e.is_held)run('runespace.music');cx.stop_propagation();return;}
    if(key==='i'){this.openInventory();cx.stop_propagation();return;}
    if(key==='enter'||key==='return'){const p=this.sim.nearest();if(p)this.openChat(p.key);cx.stop_propagation();}
    if(key==='escape'){this.sim.stopDance();this.sim.cancelAdventure();this.sim.path=[];this.sim.targetKey=null;this.hint='Walk cancelled.';cx.stop_propagation();}
    if(key==='n'){this.names=!this.names;cx.stop_propagation();}
    if(key==='-'||key==='='){this.zoom=clamp(this.zoom+(key==='='?.1:-.1),.75,1.9);cx.stop_propagation();}
    cx.notify();
  }
  pick(point){
    return this.projected.filter(p=>Math.abs(point.x-p.feet.x)<Math.max(12,this.camera.scale*p.radius)&&point.y>=p.head.y-6&&point.y<=p.feet.y+5)
      .sort((a,b)=>Number(b.agent)-Number(a.agent)||a.feet.depth-b.feet.depth)[0]?.key||null;
  }
  pointer(e,cx){
    if(!e.local_position)return;
    this.focus.focus();
    const key=this.pick(e.local_position);
    if(this.sim.npcs.has(key))this.talk(key);
    else if(key)this.interact(key);
    else this.walk(this.camera.ground(e.local_position.x,e.local_position.y));
    cx.stop_propagation();cx.notify();
  }
  projectScene(){
    const m=new Mesh(),t=Math.floor(this.sim.time*12)/12,actors=[];let newPoses=0;
    const cameraKey=[this.width,this.height,this.yaw.toFixed(3),this.zoom.toFixed(3),this.pitch.toFixed(3)].join('|'),camera=this.meshCamera,padding=Math.max(this.width,this.height);
    // Ground selection ring and shadows use the same camera projection as the meshes.
    for(const p of [...this.sim.npcs.values(),this.sim.player]){
      const elevation=elevationOf(p);
      const groundKey=cameraKey+'|'+p.x+'|'+p.z+'|'+(p.player||p.key===this.hover||p.key===this.sim.targetKey);
      let ground=this.groundActors.get(p.key);
      if(!ground||ground.key!==groundKey){
      const groundMesh=new Mesh();groundMesh.disc(p.x,p.z,p.player?.45:.36,'#28352066',elevation+.055,10);
      if(p.player||p.key===this.hover||p.key===this.sim.targetKey){
        const ring=new Mesh(),r=p.player?.53:.60;
        for(let i=0;i<18;i++){const a=i*TAU/18,b=(i+1)*TAU/18;
          ring.face([[p.x+Math.cos(a)*r,elevation+.07,p.z+Math.sin(a)*r],[p.x+Math.cos(b)*r,elevation+.07,p.z+Math.sin(b)*r],
            [p.x+Math.cos(b)*(r-.07),elevation+.07,p.z+Math.sin(b)*(r-.07)],[p.x+Math.cos(a)*(r-.07),elevation+.07,p.z+Math.sin(a)*(r-.07)]].reverse(),p.player?'#eee4b2':'#f8dc70',false);
        }groundMesh.faces.push(...ring.faces);
      }
      ground={key:groundKey,faces:camera.faces(groundMesh,padding)};this.groundActors.set(p.key,ground);
      }actors.push(...ground.faces);
      const action=poseFor(p),frames=clipFor(p,action).frames;
      const frame=Math.floor(animationPhase(p,this.sim.time)*frames);
      const appearance=[p.kind,p.host,action,p.player?this.gearKey:''].join('|');
      let poses=this.poses.get(p.key);
      if(!poses&&newPoses>=4&&!p.player)continue;
      if(!poses||poses.appearance!==appearance){
        if(!poses)newPoses++;
        poses={appearance,frames:new Array(frames)};this.poses.set(p.key,poses);
      }
      let meshPose=poses.frames[frame];
      if(!meshPose){meshPose=character({...p,classicDetail:true,posePhase:frame/frames},t);poses.frames[frame]=meshPose;}
      const actorKey=[appearance,frame,cameraKey,p.x,p.z,p.yaw].join('|');
      let actor=this.actors.get(p.key);if(!actor||actor.key!==actorKey){
        const mesh=new Mesh();mesh.transformed(meshPose,p.x,p.z,p.yaw,1,elevation);
        actor={key:actorKey,faces:camera.faces(mesh,padding)};this.actors.set(p.key,actor);
      }
      actors.push(...actor.faces);
      if((p.status==='blocked'||p.status==='error')&&!this.sim.wasStale)m.cone(p.x,2.15+Math.sin(t*3)*.07,p.z,.13,.3,'#f4b75e',4,.07);
    }
    for(const entity of this.sim.adventure.entities){
      if(entity.activity==='hidden')continue;
      const frame=entity.kind==='oak'?0:Math.floor(entity.posePhase*8)%8;
      const pose=[entity.kind,entity.activity,frame].join('/');
      let model=this.adventureMeshes.get(pose);
      if(!model){
        model=buildAdventureModel(Mesh,entity.kind,entity.activity,frame/8);
        this.adventureMeshes.set(pose,model);
      }
      const key=[cameraKey,pose,entity.x,entity.z,entity.yaw].join('|');
      let actor=this.actors.get(entity.key);
      if(!actor||actor.key!==key){
        const mesh=new Mesh();mesh.transformed(model,entity.x,entity.z,entity.yaw);
        actor={key,faces:camera.faces(mesh,padding)};this.actors.set(entity.key,actor);
      }
      actors.push(...actor.faces);
    }
    // Lively fire and sparks; these are decorative, never task progress indicators.
    for(let i=0;i<4;i++){const a=t*1.6+i*1.7;m.cone(Math.cos(a)*.2,.25,3+Math.sin(a)*.2,.25,.7+Math.sin(t*6+i)*.18,i%2?'#e7b94b':'#cd713c',5,0);}
    const end=this.sim.path[this.sim.path.length-1];if(end){
      for(const [a,b] of [[[-.2,-.2],[.2,.2]],[[-.2,.2],[.2,-.2]]])m.rod([end.x+a[0],.08,end.z+a[1]],[end.x+b[0],.08,end.z+b[1]],.025,'#f4d574');
    }
    if(cameraKey!==this.staticCamera){this.staticProjection=camera.faces(this.sim.world.mesh,padding);this.staticCamera=cameraKey;}
    return this.staticProjection.concat(actors,camera.faces(m,padding)).sort((a,b)=>a.ground!==b.ground?(a.ground?-1:1):a.ground?a.top-b.top:b.depth-a.depth);
  }
  labels(){
    const p=this.sim.player,nearest=[...this.sim.npcs.values()].sort((a,b)=>distance(a,p)-distance(b,p)).slice(0,2).filter(a=>distance(a,p)<6),visible=new Set(nearest.map(a=>a.key));
    if(this.hover)visible.add(this.hover);if(this.sim.targetKey)visible.add(this.sim.targetKey);
    this.projected=[...this.sim.npcs.values()].map(p=>{
      const elevation=elevationOf(p);
      return {key:p.key,agent:true,radius:.42,feet:this.camera.project([p.x,elevation,p.z]),head:this.camera.project([p.x,elevation+p.height,p.z])};
    });
    const elements=[];
    for(const h of this.projected){
      if(h.head.x<20||h.head.x>this.width-20||h.head.y<65||h.feet.y>this.height-85)continue;
      const p=this.sim.npcs.get(h.key),selected=visible.has(h.key);
      // The host crest is always visible; longer titles appear near you or on hover.
      elements.push(div().absolute().left(h.head.x-3).top(h.head.y+3).w(6).h(6).bg(HOST_COLOR[p.host]||'#ccbb77').border(1).border_color('#dfd5a4'));
      if(!this.names&&!selected)continue;
      const w=Math.min(240,p.name.length*6.7+22),x=clamp(h.head.x-w/2,8,this.width-w-8);
      elements.push(V().id('npc-label-'+p.key).absolute().left(x).top(h.head.y-25).w(w).px(7).py(4).bg(selected?'#24281def':'#24281dd9').border(1).border_color(selected?'#d6bd6b':'#6d7355').cursor_pointer()
        .on_mouse_down('left',(_e,cx)=>{this.talk(p.key);cx.stop_propagation();})
        .child(text(p.name,12,selected?'#ffe58d':'#e5debf').font_family('Geist').truncate()));
    }
    for(const entity of this.sim.adventure.entities){
      if(entity.activity==='hidden')continue;
      const stump=entity.activity==='stump';
      const feet=this.camera.project([entity.x,0,entity.z]);
      const head=this.camera.project([entity.x,stump?.48:entity.height,entity.z]);
      const radius=entity.kind==='oak'?(stump?.42:1.35):entity.kind==='rat'?.68:.5;
      this.projected.push({key:entity.key,agent:false,radius,feet,head});
      if(entity.hit>0)elements.push(this.hitMarker(head,entity.hit));
      if(!this.names&&this.hover!==entity.key&&this.sim.adventure.targetKey!==entity.key)continue;
      const title=adventureAction(entity),w=title.length*7+16;
      elements.push(V().id('adventure-'+entity.key).absolute().left(clamp(head.x-w/2,0,this.width-w)).top(head.y-23)
        .w(w).px(6).py(3).bg('#28271ee8').border(1).border_color('#8c8059').cursor_pointer()
        .on_mouse_down('left',(_e,cx)=>{this.interact(entity.key);cx.stop_propagation();})
        .child(text(title,12,entity.kind==='oak'?'#d7e7b0':'#f5cd91')));
    }
    const me=this.camera.project([p.x,1.95,p.z]);elements.push(div().absolute().left(me.x-18).top(me.y-15).child(text('You',12,'#fff2b4')));
    if(p.hit>0)elements.push(this.hitMarker(me,p.hit));
    return elements;
  }
  hitMarker(point,damage){
    return div().absolute().left(point.x-9).top(point.y+6).w(20).h(18).text_center()
      .bg('#8c342c').border(1).border_color('#e5b593').child(text(String(damage),13,'#fff5d8'));
  }
  minimap(){
    const size=158,scale=3.5,center=79,shapes=[];
    const rect=(x,z,w,d,c)=>div().absolute().left(center+(x-w/2)*scale).top(center+(z-d/2)*scale).w(w*scale).h(d*scale).bg(c);
    shapes.push(rect(-16,0,3.8,40,'#5a8289'),rect(0,3,3,34,'#ab9d75'),rect(0,3,29,2,'#ab9d75'),rect(0,-11,12,5,'#a6a28a'),rect(11,8,6,4,'#b38660'));
    for(const p of this.sim.npcs.values())shapes.push(div().absolute().left(center+p.x*scale-2).top(center+p.z*scale-2).w(4).h(4).bg(statusColor(p.status)));
    shapes.push(div().absolute().left(center+this.sim.player.x*scale-3).top(center+this.sim.player.z*scale-3).w(6).h(6).bg('#fff4ba').border(1).border_color('#292719'));
    return V().absolute().top(18).right(18).w(178).bg('#292c22ee').border(2).border_color('#8a7b55').p(8).gap(5)
      .on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
      .child(h_flex().justify_between().child(text('GUILD MAP',12,'#f0d476')).child(text('N ↑',11,'#bfb89c')))
      .child(div().id('runespace-minimap').relative().w(size).h(size).overflow_hidden().bg('#586e3e').children(shapes)
        .on_mouse_down('left',(e,cx)=>{if(e.local_position)this.walk({x:(e.local_position.x-center)/scale,z:(e.local_position.y-center)/scale});cx.stop_propagation();}))
      .child(h_flex().gap(5).child(button('world-home','Commons',()=>this.home())).child(button('world-names',this.names?'Names on':'Names',()=>{this.names=!this.names;},this.names)));
  }
  render(cx){
    if(['metal','play','sound','world-recovery'].includes(shared('runespace.mode')))return div().relative().size_full().bg('#22281f')
      .child(panel().absolute().top(24).left(24).right(24)
        .child(text('The Guild Green',24,'#efcf76').font_family('Georgia'))
        .child(text(shared('runespace.metalState')||'Entering the Guild Green…',14))
        .child(text('Click a companion to walk over and open their conversation here.',13))
        .when(shared('runespace.mode')!=='play',e=>e.child(button('retry-world','Return to Guild world',()=>run('runespace.world')))));
    const nearest=this.sim.nearest(),hovered=this.sim.npcs.get(this.hover),talking=hovered||nearest;
    const adventure=this.sim.adventure;
    const target=adventure.entities.find(e=>e.key===adventure.targetKey);
    const pointed=adventure.entities.find(e=>e.key===this.hover);
    const opponent=target&&target.kind!=='oak'?target:null;
    const roster=[...this.sim.npcs.values()],workers=roster.filter(a=>a.status==='working').length,idle=roster.filter(a=>a.status==='idle').length;
    const root=div().id('runespace-world').relative().size_full().min_w(0).min_h(0).overflow_hidden().bg('#8f9e77').track_focus(this.focus).key_context('GuildWorld')
      .on_size_change((s,cx)=>{this.width=s.width;this.height=s.height;cx.notify();})
      .on_mouse_down('left',(e,cx)=>this.pointer(e,cx))
      .on_mouse_down('right',(e,cx)=>{this.focus.focus();this.drag=e.local_position;cx.stop_propagation();})
      .on_mouse_up('right',(_e,cx)=>{this.drag=null;cx.stop_propagation();})
      .on_mouse_move((e,cx)=>{
        const point=e.local_position;if(!point)return;
        if(this.drag){
          this.yaw+=(point.x-this.drag.x)*.006;
          this.pitch=clampPitch(this.pitch+(this.drag.y-point.y)*.006);
          this.drag=point;
        }
        const hover=this.pick(point);if(this.hover!==hover||this.drag){this.hover=hover;cx.notify();}
      })
      .on_hover((inside,_cx)=>{if(!inside){this.hover=null;this.drag=null;}})
      .on_scroll_wheel((e,cx)=>{this.zoom=clamp(this.zoom-e.delta.y*.002,.75,1.9);cx.stop_propagation();cx.notify();})
      .on_key_down((e,cx)=>this.key(e,cx,true)).on_key_up((e,cx)=>this.key(e,cx,false))
      .child(div().absolute().left(-(this.follow.x*this.camera.right[0]+this.follow.z*this.camera.right[2])*this.camera.scale)
        .top(-(this.follow.x*this.camera.up[0]+this.follow.z*this.camera.up[2])*this.camera.scale).w(this.width).h(this.height).children(this.layers))
      .children(this.labels());
    // Landmarks are unobtrusive screen-facing signs placed in the 3D world.
    for(const [name,x,y,z] of [['GUILD BANK',0,3.2,-8.2],['WOODLAND',-10,.2,-11],['ORE QUARRY',11,.2,-12],['THE FORGE',11,.2,11.5],['ALLOTMENTS',10.7,.2,16.9]]){
      const p=this.camera.project([x,y,z]);if(p.x>30&&p.x<this.width-180&&p.y>90&&p.y<this.height-100)root.child(div().absolute().left(p.x-60).top(p.y).w(120).text_center().child(text(name,11,'#eee2b1')));
    }
    root.child(panel().absolute().left(18).top(18).w(255).on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
      .child(h_flex().items_center().justify_between()
        .child(text('THE GUILD GREEN',20,'#efcf76').font_family('Georgia'))
        .child(button('runespace-dance','Dance  G',()=>this.dance(),this.sim.player.activity==='dance')))
      .child(text(this.sim.wasStale?'Reconnecting to your company…':workers+' working  ·  '+idle+' at the commons',12,'#c9c5a6'))
      .child(text(hovered?'Talk-to '+hovered.name:pointed?adventureAction(pointed):'Click an oak to chop, a creature to fight, or a companion to chat.',12,'#f3e0a6').font_family('Geist'))
      .when(!!adventure.message,e=>e.child(text(adventure.message,12,'#ffe18d')))
      .when(!!opponent,e=>e.child(text('You '+adventure.hp+'/'+adventure.maxHp+' HP · '+opponent.name+' '+opponent.hp+'/'+opponent.maxHp+' HP',12,'#f7ca9e')))
      .when(adventure.logs>0||adventure.combatXp>0,e=>e.child(text(adventure.logs+' logs · Woodcutting '+adventure.woodXp+' XP · Combat '+adventure.combatXp+' XP',11,'#dfd7b2'))));
    root.child(this.minimap());
    root.child(h_flex().absolute().right(18).top(252)
      .on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
      .child(button('world-music','♫ Music  M',()=>run('runespace.music'))));
    root.child(h_flex().absolute().bottom(16).left(18).right(18).gap(14).items_end()
      .on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
      .child(panel().flex_1().max_w(530)
        .child(text(talking?talking.name:this.sim.path.length?this.hint:'Your company, in one world.',16,'#f3d585').font_family('Georgia'))
        .child(text(talking?((talking.machineName || talking.host)+' · '+talking.kind+' '+talking.guildClass+' · '+ACTIVITY[talking.activity]):'Idle companions gather by the fire. Working companions practise their skills.',12,'#d7d2b5').font_family('Geist'))
        .when(!!talking,e=>e.child(h_flex().gap(8).items_center().child(button('talk-npc',nearest?.key===talking?.key?'Open chat  ↵':'Walk over & chat',()=>nearest?.key===talking?.key?this.openChat(talking.key):this.talk(talking.key),true)).child(text('Opens this existing session',10,'#bab99e')))))
      .child(div().flex_1())
      .child(panel().w(255).child(text('W/S  Tilt     A/D  Rotate     Scroll  Zoom',12,'#ddcf9e')).child(text('Arrow keys or click  Walk     Enter  Chat',11,'#c1bea2')).child(text('Right-drag to orbit · N names · Esc cancels walking',10,'#a7ac91'))));
    return root;
  }
}
