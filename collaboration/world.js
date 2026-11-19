import {Simulation, Camera, Mesh, character, poseFor, animationPhase, clamp, clampPitch, hash, ACTIVITY, mergeAdventureProgress} from '/world/world-engine.js';
import {normalizeLoadout, equipItem} from '/world/equipment.js';
import {createAdventureProfile} from './adventure-profile.js';
import {createAgentScene} from './agent-scene.js';
import {buildAdventureModel} from '/world/world-art.js';

const hats = ['red', 'green', 'purple', 'blue', 'white', 'yellow'];
const arrow = {ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right'};
const directions = new Set([...Object.keys(arrow), 'w', 'a', 's', 'd']);
const groundHeight = ({x,z}) => x > -18.8 && x < -13.3 && z > 1.9 && z < 4.1 ? .43 : 0;

// Upload the same hand-built polygon meshes the desktop world uses. Terrain stays on the GPU.
function gpuSurface(canvas) {
  const gl = canvas.getContext('webgl', {alpha:false, antialias:true, powerPreference:'high-performance'});
  if (!gl) return null;
  const program = gl.createProgram();
  const shaders = [
    [gl.VERTEX_SHADER, 'attribute vec3 point; attribute vec3 tint; uniform vec4 model; uniform vec3 origin,right,up,depth; varying lowp vec3 color; void main(){ vec3 p=vec3(point.x*model.z+point.z*model.w+model.x,point.y,point.z*model.z-point.x*model.w+model.y)-origin; gl_Position=vec4(dot(p,right),dot(p,up)-0.04,dot(p,depth)*0.008,1.0); color=tint; }'],
    [gl.FRAGMENT_SHADER, 'precision lowp float; varying lowp vec3 color; void main(){gl_FragColor=vec4(color,1.0);}']
  ];
  for(const [type,source] of shaders){
    const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program,shader);gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);
  const point=gl.getAttribLocation(program,'point'),tint=gl.getAttribLocation(program,'tint');
  const u=Object.fromEntries(['right','up','depth','origin','model'].map(k=>[k,gl.getUniformLocation(program,k)]));
  const colors=new Map();
  gl.enableVertexAttribArray(point);gl.enableVertexAttribArray(tint);
  let camera;
  return {
    upload(mesh){
      const data=[];
      for(const f of mesh.faces){
        let rgb=colors.get(f.color);
        if(!rgb){rgb=[1,3,5].map(i=>parseInt(f.color.slice(i,i+2),16)/255);colors.set(f.color,rgb);}
        for(let i=1;i<f.points.length-1;i++)for(const p of [f.points[0],f.points[i],f.points[i+1]])data.push(...p,...rgb);
      }
      const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);
      return {buffer,count:data.length/6};
    },
    release(mesh){gl.deleteBuffer(mesh.buffer);},
    start(c){
      camera=c;gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(.45,.52,.39,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.uniform3fv(u.right,c.right.map(v=>v*c.scale*2/c.width));
      gl.uniform3fv(u.up,c.up.map(v=>-v*c.scale*2/c.height));gl.uniform3fv(u.depth,c.forward);
    },
    draw(mesh,x=0,z=0,yaw=0,y=0){
      gl.bindBuffer(gl.ARRAY_BUFFER,mesh.buffer);gl.vertexAttribPointer(point,3,gl.FLOAT,false,24,0);gl.vertexAttribPointer(tint,3,gl.FLOAT,false,24,12);
      gl.uniform3f(u.origin,camera.focus.x,-y,camera.focus.z);gl.uniform4f(u.model,x,z,Math.cos(yaw),Math.sin(yaw));
      gl.drawArrays(gl.TRIANGLES,0,mesh.count);
    },
    end(){},dispose(){gl.deleteProgram(program);}
  };
}

// Canvas fallback shares mesh geometry, navigation and the same world coordinates.
function paintedSurface(canvas) {
  const ctx=canvas.getContext('2d');
  let camera,faces=[],terrainView='',terrainFaces=[];
  return {slow:true,upload:mesh=>mesh,release(){},dispose(){},
    start(c){camera=c;faces=[];ctx.setTransform(canvas.width/c.width,0,0,canvas.height/c.height,0,0);ctx.fillStyle='#768768';ctx.fillRect(0,0,c.width,c.height);},
    draw(mesh,x,z,yaw,y){
      if(x===undefined){
        const view=[camera.width,camera.height,camera.focus.x.toFixed(3),camera.focus.z.toFixed(3),camera.yaw,camera.pitch,camera.scale].join('/');
        if(view!==terrainView){terrainFaces=camera.faces(mesh);terrainView=view;}
        faces.push(...terrainFaces);return;
      }
      const placed=new Mesh();placed.transformed(mesh,x,z,yaw,1,y);faces.push(...camera.faces(placed));
    },
    end(){faces.sort((a,b)=>a.ground!==b.ground?(a.ground?-1:1):a.ground?a.top-b.top:b.depth-a.depth);for(const f of faces){ctx.beginPath();ctx.moveTo(...f.points[0]);for(let i=1;i<f.points.length;i++)ctx.lineTo(...f.points[i]);ctx.closePath();ctx.fillStyle=f.color;ctx.fill();}}
  };
}

export function createGuildWorld({canvas,labels,onMove,onInspect=()=>{},onAgent,onAdventure=()=>{},onInventory=()=>{}}) {
  const sim=new Simulation(), adventures=new Map();
  let surface=gpuSurface(canvas)??paintedSurface(canvas),terrain=surface.upload(sim.world.mesh),fallbackCanvas;
  let storage;
  try { storage=window.localStorage; } catch {}
  const profile=createAdventureProfile(sim,{storage,locks:navigator.locks,merge:mergeAdventureProgress,onError:onInspect});
  const campfire=new Mesh();
  for(let i=0;i<7;i++){const t=i*2.4;campfire.cone(Math.cos(t)*.21,0,Math.sin(t)*.22,.24,.55+i%3*.16,i%2?'#e89b37':'#ba4928',5);}
  campfire.cone(.06,.04,.10,.21,.62,'#ffcc5a',5);let fire=surface.upload(campfire);
  const ring=new Mesh();for(let i=0;i<24;i++){const a=i*Math.PI/12,b=(i+1)*Math.PI/12;ring.face([[Math.sin(a)*.53,.04,Math.cos(a)*.53],[Math.sin(b)*.53,.04,Math.cos(b)*.53],[Math.sin(b)*.47,.04,Math.cos(b)*.47],[Math.sin(a)*.47,.04,Math.cos(a)*.47]],'#e9d49a',false);}
  let selected=surface.upload(ring);
  const poses=new Map(),tags=new Map(),peers=new Map();
  let keys={},self=null,enabled=false,camera,lastFrame=0,lastPaint=0,handle,seq=0,lastSend=0,lastPose=null;
  let yaw=.24,pitch=.76,zoom=1.20,focus={x:-1.6,z:-1.7},hover=null,alive=true,w=1,h=1;
  const sent=new Map(),hits=[];
  let lastAdventure='',lastGear='',showNames=false;
  const listeners=new AbortController(),listen=(target,type,fn,options={})=>target.addEventListener(type,fn,{...options,signal:listeners.signal});
  function resize(){
    w=Math.max(1,canvas.clientWidth);h=Math.max(1,canvas.clientHeight);
    const ratio=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);
    if(fallbackCanvas){fallbackCanvas.width=canvas.width;fallbackCanvas.height=canvas.height;}
    camera=new Camera(w,h,focus,yaw,zoom,pitch);
  }
  const observer=new ResizeObserver(resize);observer.observe(canvas);resize();

  function outfit(id) {
    const color=hash(id)%hats.length;
    return normalizeLoadout({head:hats[color]+'-partyhat',cape:color%2?'cape-of-legends':'fire-cape'});
  }
  function meshFor(p,time,human=false){
    const activity=poseFor(p),frames=activity==='idle'?1:activity==='attack'?12:8;
    const phase=frames===1?0:Math.floor(animationPhase(p,time)*frames)%frames;
    const gear=human?(p.loadout??outfit(p.key)):null;
    const look=human?'human/'+Object.values(gear).join('/') : p.kind;
    const key=[look,activity,phase].join('/');
    let mesh=poses.get(key);
    if(!mesh){
      const model={...p,key:look,host:'local',classicDetail:true,posePhase:phase/frames};
      if(human){model.player=true;model.loadout=gear;}
      mesh=surface.upload(character(model,time));poses.set(key,mesh);
      if(poses.size>512){const oldest=poses.keys().next().value;surface.release(poses.get(oldest));poses.delete(oldest);}
    }
    return mesh;
  }
  function interact(key) {
    if (!enabled) return;
    sim.interact(key);
    canvas.focus({preventScroll:true});
  }
  function approachAgent(key){
    if(!enabled||!sim.npcs.has(key))return false;
    if(sim.approach(key))return true;
    onInspect('There is no clear path to that agent.');
    return false;
  }
  function tag(id,name,actor,type,seen,height=2.22,action){
    const pos=camera.project([actor.x,groundHeight(actor)+height,actor.z]);
    if(pos.x<0||pos.x>w||pos.y<0||pos.y>h)return;
    seen.add(id);let el=tags.get(id);
    if(!el){
      el=document.createElement(action?'button':'span');
      el.className='world-tag '+type;
      if(action){el.type='button';el.addEventListener('click',action);}
      tags.set(id,el);labels.append(el);
    }
    if(el.textContent!==name)el.textContent=name;
    el.style.left=pos.x.toFixed(1)+'px';el.style.top=pos.y.toFixed(1)+'px';
  }
  function draw(time){
    camera=new Camera(w,h,focus,yaw,zoom,pitch);surface.start(camera);surface.draw(terrain);
    surface.draw(fire,0,3,Math.sin(time*2.6)*.18,.03);
    const seen=new Set();hits.length=0;
    for(const target of sim.adventure.entities){
      if(target.activity==='hidden')continue;
      const stump=target.activity==='stump',tree=target.kind==='oak';
      const frame=tree?0:Math.min(7,Math.floor(target.posePhase*8));
      const pose=[target.kind,target.activity,frame].join('/');
      if(!adventures.has(pose))adventures.set(pose,surface.upload(buildAdventureModel(Mesh,target.kind,target.activity,frame/8)));
      surface.draw(adventures.get(pose),target.x,target.z,target.yaw,0);
      if(!enabled)continue;
      const height=stump?.42:target.height,foot=camera.project([target.x,0,target.z]),head=camera.project([target.x,height,target.z]);
      const radius=tree?(stump?.48:1.32):target.kind==='rat'?.75:.5;
      hits.push({id:target.key,type:'adventure',x:foot.x,head:head.y,feet:foot.y,depth:foot.depth,radius:Math.max(12,camera.scale*radius)});
      const engaged=sim.adventure.targetKey===target.key;
      if(engaged)surface.draw(selected,target.x,target.z,0,.005);
      if(showNames||hover===target.key||engaged||Math.hypot(sim.player.x-target.x,sim.player.z-target.z)<8){
        let title=stump?'Oak stump':tree?'Chop oak':'Attack '+target.name.toLowerCase();
        if(engaged&&!tree)title=target.name+' · '+target.hp+'/'+target.maxHp+' HP';
        tag(target.key,title,target,'adventure',seen,height+.1,()=>interact(target.key));
      }
      if(target.hit>0)tag('hit/'+target.key,String(target.hit),target,'hit',seen,height*.65);
    }
    function actor(p,name,id,human){
      const foot=camera.project([p.x,groundHeight(p),p.z]);if(foot.x< -50||foot.x>w+50||foot.y< -15||foot.y>h+100)return;
      const y=groundHeight(p),head=camera.project([p.x,y+(p.height||2),p.z]);
      if(id===self)surface.draw(selected,p.x,p.z,0,y);
      surface.draw(meshFor(p,sim.time,human),p.x,p.z,p.yaw,y);
      if(id!==self)hits.push({id,type:human?'human':'agent',x:foot.x,head:head.y,feet:foot.y,depth:foot.depth,radius:Math.max(12,camera.scale*.48)});
      if(human||showNames||hover===id)tag(id,id===self?name+' · you':name,p,human?'human':'agent',seen,2.22,human?null:()=>approachAgent(id));
      if(id===self&&p.hit>0)tag('player-hit',String(p.hit),p,'hit',seen,1.72);
    }
    for(const p of sim.npcs.values())actor(p,p.ownerName ? p.name+' · '+p.ownerName : p.name,p.key,false);
    for(const p of peers.values())actor(p.id===self?{...sim.player,key:p.id}:p,p.name,p.id,true);
    surface.end();
    for(const [id,el] of tags)if(!seen.has(id)){el.remove();tags.delete(id);}
  }
  const agentScene = createAgentScene(sim);
  function sync({self:id,peers:members,agents=[],scene=[]}){
    const initial=!enabled||self!==id||!peers.has(id);
    self=id;
    const valid=new Set();
    for(const peer of members){
      valid.add(peer.id);
      const current=peers.get(peer.id);
      if(!current)peers.set(peer.id,{...peer,key:peer.id,player:true,activity:'idle',tx:peer.x,tz:peer.z,tyaw:peer.yaw});
      else Object.assign(current,{name:peer.name,tx:peer.x,tz:peer.z,tyaw:peer.yaw});
      const avatar=peers.get(peer.id);
      if(peer.loadout)avatar.loadout=peer.loadout;
      if(avatar.activity!==(peer.activity||'idle')){
        avatar.activity=peer.activity||'idle';avatar.actionStartedAt=sim.time;avatar.danceStartedAt=sim.time;
      }
      if(peer.id!==id)continue;
      if(Number.isSafeInteger(peer.seq))seq=Math.max(seq,peer.seq);
      if(initial){
        profile.open(peer.name);sim.player.loadout=normalizeLoadout(profile.readGear()||outfit(peer.name));
        lastAdventure='';lastGear='';Object.assign(sim.player,{x:peer.x,z:peer.z,yaw:peer.yaw});focus={x:peer.x*.75,z:peer.z*.58-2};}
      else if(sent.has(peer.seq)){
        const predicted=sent.get(peer.seq),dx=peer.x-predicted.x,dz=peer.z-predicted.z;
        if(Math.hypot(dx,dz)>.03){
          const x=sim.player.x+dx,z=sim.player.z+dz;
          if(sim.blocked(x,z)){sim.player.x=peer.x;sim.player.z=peer.z;sim.path=[];}
          else{sim.player.x=x;sim.player.z=z;}
          for(const [n,p] of sent)if(n>peer.seq){p.x+=dx;p.z+=dz;}
        }
        for(const n of sent.keys())if(n<=peer.seq)sent.delete(n);
      }
    }
    for(const id of peers.keys())if(!valid.has(id))peers.delete(id);
    agentScene.sync(agents, scene);
  }
  function setActive(active){if(active===enabled)return;enabled=active;keys={};sim.path=[];lastPose=null;if(!active){sent.clear();sim.cancelAdventure();sim.stopDance();sim.targetKey=null;sim.arrived=null;profile.save();}}
  function reset(){
    setActive(false);profile.close();self=null;peers.clear();sent.clear();seq=0;hover=null;agentScene.sync([],[]);focus={x:-1.6,z:-1.7};yaw=.24;pitch=.76;zoom=1.2;
  }
  function animate(now){
    if(!alive)return;const dt=Math.min(.08,(now-lastFrame)/1000||0);lastFrame=now;
    if(enabled){
      yaw+=((keys.d?1:0)-(keys.a?1:0))*dt*1.6;pitch=clampPitch(pitch+((keys.w?1:0)-(keys.s?1:0))*dt);
      sim.step(dt,keys,yaw);
      agentScene.draw();
      profile.save();
      if(sim.arrived){
        const agent=sim.npcs.get(sim.arrived);sim.arrived=null;
        if(agent){if(onAgent)onAgent(agent);else onInspect(agent.name+' · '+(ACTIVITY[agent.activity]??agent.status));}
      }
      const a=sim.adventure,p=sim.player,target=a.entities.find(e=>e.key===a.targetKey);
      const summary=[a.message,a.hp,a.logs,a.woodXp,a.combatXp,target?.hp].join('/');
      if(summary!==lastAdventure){
        lastAdventure=summary;onAdventure({message:a.message,hp:a.hp,maxHp:a.maxHp,logs:a.logs,woodXp:a.woodXp,combatXp:a.combatXp});
      }
      const activity=['wood','attack','dance'].includes(p.activity)?p.activity:'idle';
      const gear=Object.values(p.loadout||{}).join('/');
      const recover=a.message==='You recover at the commons.'&&p.x===0&&p.z===12;
      if(now-lastSend>=95&&(!lastPose||Math.hypot(p.x-lastPose.x,p.z-lastPose.z)>.005||Math.abs(p.yaw-lastPose.yaw)>.02||lastPose.activity!==activity||lastPose.moving!==!!p.moving||lastGear!==gear)){
        const packet={x:p.x,z:p.z,yaw:p.yaw,activity,moving:!!p.moving,seq:++seq};
        if(gear!==lastGear){packet.loadout=p.loadout;lastGear=gear;}
        if(recover)packet.recover=true;
        lastPose={...packet};sent.set(seq,{x:p.x,z:p.z});
        if(sent.size>35)sent.delete(sent.keys().next().value);onMove(packet);lastSend=now;
      }
      const amount=1-Math.exp(-dt*8);focus.x+=(p.x*.75-focus.x)*amount;focus.z+=(p.z*.58-2-focus.z)*amount;
    }
    for(const p of peers.values()){
      if(p.id===self)continue;const dx=p.tx-p.x,dz=p.tz-p.z,d=Math.hypot(dx,dz),a=d>4?1:1-Math.exp(-dt*18);
      p.x+=dx*a;p.z+=dz*a;p.yaw=p.tyaw;p.moving=d>.035;
    }
    if(!document.hidden&&now-lastPaint>=(surface.slow?70:0)){draw(now/1000);lastPaint=now;}
    handle=requestAnimationFrame(animate);
  }
  const position=e=>{const rect=canvas.getBoundingClientRect();return {x:e.clientX-rect.left,y:e.clientY-rect.top};};
  const pick=({x,y})=>hits.filter(p=>Math.abs(x-p.x)<=p.radius&&y>=p.head-6&&y<=p.feet+5).sort((a,b)=>Number(b.type==='agent')-Number(a.type==='agent')||a.depth-b.depth)[0];
  listen(canvas,'pointermove',e=>{const hit=pick(position(e));hover=hit?.id;canvas.style.cursor=enabled?(hit?'pointer':'crosshair'):'default';});
  listen(canvas,'pointerleave',()=>{hover=null;});
  listen(canvas,'pointerdown',e=>{
    if(!enabled||e.button!==0)return;canvas.focus({preventScroll:true});const pos=position(e),hit=pick(pos);
    if(hit?.type==='agent'){approachAgent(hit.id);return;}
    if(hit?.type==='adventure'){interact(hit.id);return;}
    const target=hit&&peers.get(hit.id);
    if(target){
      const l=Math.atan2(sim.player.x-target.x,sim.player.z-target.z);
      sim.walk({x:target.x+Math.sin(l)*1.8,z:target.z+Math.cos(l)*1.8});
    }else sim.walk(camera.ground(pos.x,pos.y));
  });
  listen(canvas,'wheel',e=>{if(enabled){zoom=clamp(zoom*Math.exp(-e.deltaY*.0012),.72,2.15);e.preventDefault();}},{passive:false});
  listen(window,'keydown',e=>{
    if(!enabled||e.altKey||e.ctrlKey||e.metaKey||e.target?.matches('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open]'))return;
    const key=e.key.length===1?e.key.toLowerCase():e.key;
    if(!e.repeat){
      if(key==='Escape'){sim.cancelAdventure();sim.stopDance();sim.path=[];sim.targetKey=null;}
      if(key==='i')onInventory();
      if(key==='g')sim.dance();
      if(key==='n')showNames=!showNames;
      if(key==='Enter'&&e.target===canvas){const near=sim.nearest();if(near)approachAgent(near.key);}
    }
    if(directions.has(key)){keys[arrow[key]||key]=true;e.preventDefault();}
  });
  listen(window,'keyup',e=>{delete keys[arrow[e.key]||e.key.toLowerCase()];});listen(window,'blur',()=>{keys={};});
  function switchSurface(next) {
    surface.dispose();surface=next;
    poses.clear();adventures.clear();
    terrain=surface.upload(sim.world.mesh);
    fire=surface.upload(campfire);selected=surface.upload(ring);
    lastPaint=0;
  }
  listen(canvas,'webglcontextlost',event=>{
    event.preventDefault();
    if(fallbackCanvas||!alive)return;
    // A canvas owns its graphics context for its lifetime. Keep the input
    // surface and the running simulation while another canvas paints the world.
    fallbackCanvas=document.createElement('canvas');
    fallbackCanvas.className='world-recovery';fallbackCanvas.setAttribute('aria-hidden','true');
    fallbackCanvas.width=canvas.width;fallbackCanvas.height=canvas.height;
    canvas.after(fallbackCanvas);switchSurface(paintedSurface(fallbackCanvas));
  });
  listen(canvas,'webglcontextrestored',()=>{
    if(!fallbackCanvas||!alive)return;
    const recovered=gpuSurface(canvas);
    if(!recovered)return;
    switchSurface(recovered);fallbackCanvas.remove();fallbackCanvas=null;
  });
  listen(window,'storage',e=>profile.refresh(e.key));
  listen(window,'pagehide',()=>profile.save());
  handle=requestAnimationFrame(animate);
  return {sync,setActive,reset,approachAgent,
    getLoadout:()=>normalizeLoadout(sim.player.loadout),
    equip(slot,item){sim.player.loadout=equipItem(profile.readGear()||sim.player.loadout,slot,item);profile.writeGear(sim.player.loadout);return sim.player.loadout;},
    dispose(){alive=false;cancelAnimationFrame(handle);listeners.abort();observer.disconnect();
    for(const m of [terrain,fire,selected,...poses.values(),...adventures.values()])surface.release(m);surface.dispose();fallbackCanvas?.remove();labels.replaceChildren();}};
}
