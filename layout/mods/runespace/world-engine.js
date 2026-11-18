import {buildWorldArt,buildCharacter,TREES,ROCKS,WORK_CYCLES,classFor,heightFor} from './world-art.js';
export {TREES,ROCKS};
// Original low-poly geometry and a small walking simulation. No renderer or network dependencies.
export const TAU=Math.PI*2;
export const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
export function hash(s){let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return h>>>0;}
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const mul=(a,n)=>a.map(v=>v*n);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>mul(a,1/(Math.hypot(...a)||1));
const LIGHT=unit([-0.6,1,0.4]);
function shade(hex,n){const rgb=hex.match(/[a-f0-9]{2}/gi).map(v=>parseInt(v,16)),light=Math.round(n*8)/8;return '#'+rgb.slice(0,3).map(v=>Math.round(clamp(v*light,0,255)).toString(16).padStart(2,'0')).join('');}

export class Mesh {
  constructor(){this.faces=[];}
  face(points,color,lit=true){
    const normal=unit(cross(sub(points[1],points[0]),sub(points[2],points[0])));
    this.faces.push({points,color:lit?shade(color,0.60+0.40*Math.max(0,dot(normal,LIGHT))):color,normal});
  }
  box(x,y,z,w,h,d,c){
    const p=[[x-w/2,y,z-d/2],[x+w/2,y,z-d/2],[x+w/2,y+h,z-d/2],[x-w/2,y+h,z-d/2],
      [x-w/2,y,z+d/2],[x+w/2,y,z+d/2],[x+w/2,y+h,z+d/2],[x-w/2,y+h,z+d/2]];
    for(const f of [[0,3,2,1],[4,5,6,7],[0,4,7,3],[1,2,6,5],[3,7,6,2]])this.face(f.map(i=>p[i]),c);
  }
  cone(x,y,z,r,h,c,n=7,top=0,phase=0){
    const a=[],b=[];for(let i=0;i<n;i++){const t=TAU*i/n+phase;a.push([x+Math.cos(t)*r,y,z+Math.sin(t)*r]);b.push([x+Math.cos(t)*top,y+h,z+Math.sin(t)*top]);}
    for(let i=0;i<n;i++){const j=(i+1)%n;this.face(top>0?[a[i],b[i],b[j],a[j]]:[a[i],b[i],a[j]],c);}
    if(top>0)this.face([...b].reverse(),c);
  }
  disc(x,z,r,c,y=.025,n=14){const p=[];for(let i=n-1;i>=0;i--)p.push([x+Math.cos(i*TAU/n)*r,y,z+Math.sin(i*TAU/n)*r]);this.face(p,c,false);}
  rod(a,b,r,c){
    const axis=unit(sub(b,a)),u=mul(unit(cross(axis,Math.abs(axis[1])>.9?[1,0,0]:[0,1,0])),r),v=mul(unit(cross(axis,u)),r);
    const corners=p=>[add(add(p,u),v),add(sub(p,u),v),sub(sub(p,u),v),add(sub(p,v),u)];
    const p=corners(a),q=corners(b);for(let i=0;i<4;i++){let j=(i+1)%4;this.face([p[i],p[j],q[j],q[i]],c);}this.face(q,c);
  }
  transformed(other,x,z,yaw=0,scale=1,elevation=0){
    const c=Math.cos(yaw),s=Math.sin(yaw);
    for(const f of other.faces){
      const points=f.points.map(p=>[x+(p[0]*c+p[2]*s)*scale,p[1]*scale+elevation,z+(-p[0]*s+p[2]*c)*scale]),n=f.normal;
      this.faces.push({points,color:f.color,normal:[n[0]*c+n[2]*s,n[1],-n[0]*s+n[2]*c]});
    }
  }
}

// Face the resource center and place the feet where the corresponding tool
// reaches its contact surface. The east riverbank is clear of the bridge.
const station=(x,z,faceX,faceZ)=>({x,z,faceX,faceZ});
const circles=(centers,radius,angles)=>angles.flatMap(angle=>centers.map(([x,z])=>
  station(x+radius*Math.sin(angle),z+radius*Math.cos(angle),x,z)));
const anvils=[[9,5.2],[12,5.2],[14,7]];
const banks=[-2,1,7,10,13,16,-5,-9,-13,-16,18,5.1,-18];
const plots=[8.2,10.7,13.2];
export const STATIONS={
  wood:circles(TREES.filter(([x])=>x>=-13),1.4,[0,Math.PI,Math.PI/2,-Math.PI/2]),
  mine:circles(ROCKS,1.52,[0,Math.PI,Math.PI/2,-Math.PI/2]),
  smith:circles(anvils,1.0,[0,Math.PI]),
  fish:[...banks.map(z=>station(-13.1,z,-15.9,z)),...banks.map(z=>station(-19.0,z,-16.2,z))],
  farm:[...plots.map(x=>station(x,13.95,x,15.3)),...plots.map(x=>station(x,16.65,x,15.3))],
};
const SKILLS=Object.keys(STATIONS);
export const ACTIVITY={wood:'Chopping wood',mine:'Mining ore',smith:'Smithing',fish:'Fishing',farm:'Tending crops',
  waiting:'Waiting for a skill station',idle:'At the commons',blocked:'Needs your attention',error:'Needs your attention',unknown:'Status unknown'};
export const MOTION={
  ...Object.fromEntries(Object.entries(WORK_CYCLES).map(([pose,seconds])=>
    [pose,{seconds,frames:pose==='idle'?1:pose==='fish'?24:16}])),
  dance:{seconds:4,frames:40},attack:{seconds:1.2,frames:12}
};
export function poseFor(person){
  if(person.moving)return 'walk';
  if(person.player&&(person.activity==='dance'||person.activity==='attack'))return person.activity;
  return STATIONS[person.activity]?person.activity:'idle';
}
// The fire cape flows while its wearer stands still. Idle companions share a single pose.
export const PLAYER_IDLE_CLIP={seconds:2.4,frames:16};
export function clipFor(person,pose){
  return person.player&&pose==='idle'?PLAYER_IDLE_CLIP:MOTION[pose];
}
export function animationPhase(person,time){
  const pose=poseFor(person),clock=clipFor(person,pose);
  if(pose==='dance')return clamp((time-(person.danceStartedAt??time))/clock.seconds,0,1-Number.EPSILON);
  if(person.player&&Number.isFinite(person.actionStartedAt)){
    const cycles=Math.max(0,(time-person.actionStartedAt)/clock.seconds);
    if(pose==='wood')return cycles%1;
    if(pose==='attack')return Math.min(cycles,1-Number.EPSILON);
  }
  return clock.frames===1?0:(time/clock.seconds+(hash(person.key||'player')%4096)/4096)%1;
}
export const HOST_COLOR={local:'#527d58',remote:'#527da9',other:'#91689a'};

export function makeWorld(){return buildWorldArt(Mesh,hash);}

export const DEFAULT_PITCH=.82;
export const clampPitch=pitch=>Number.isFinite(pitch)?clamp(pitch,.35,1.35):DEFAULT_PITCH;

export class Camera {
  constructor(width,height,focus={x:0,z:0},yaw=.18,zoom=1,pitch=DEFAULT_PITCH){
    this.width=width;this.height=height;this.focus=focus;this.yaw=yaw;this.zoom=zoom;
    this.pitch=clampPitch(pitch);this.scale=Math.min(width/37,height/28)*zoom;
    this.right=[Math.cos(yaw),0,-Math.sin(yaw)];
    this.forward=[-Math.sin(yaw)*Math.cos(this.pitch),-Math.sin(this.pitch),-Math.cos(yaw)*Math.cos(this.pitch)];
    this.up=cross(this.forward,this.right);
  }
  project(p){const v=sub(p,[this.focus.x,0,this.focus.z]);return{x:this.width*.5+dot(v,this.right)*this.scale,y:this.height*.52+dot(v,this.up)*this.scale,depth:dot(v,this.forward)};}
  ground(x,y){
    const sx=(x-this.width*.5)/this.scale,sy=(y-this.height*.52)/this.scale;
    const a=this.right[0],b=this.right[2],c=this.up[0],d=this.up[2],det=a*d-b*c;
    return{x:this.focus.x+(sx*d-b*sy)/det,z:this.focus.z+(a*sy-sx*c)/det};
  }
  faces(mesh,padding=0){
    const out=[],r=this.right,u=this.up,d=this.forward,scale=this.scale,cx=this.width*.5,cy=this.height*.52;
    for(const f of mesh.faces){
      const n=f.normal;if(n[0]*d[0]+n[1]*d[1]+n[2]*d[2]>=-.001)continue;
      let depth=0,top=-Infinity,minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;const points=[];
      for(const p of f.points){
        const x=p[0]-this.focus.x,y=p[1],z=p[2]-this.focus.z;
        const px=cx+(x*r[0]+z*r[2])*scale,py=cy+(x*u[0]+y*u[1]+z*u[2])*scale;
        points.push([px,py]);depth+=x*d[0]+y*d[1]+z*d[2];top=Math.max(top,y);
        minX=Math.min(minX,px);maxX=Math.max(maxX,px);minY=Math.min(minY,py);maxY=Math.max(maxY,py);
      }
      if(maxX<-padding||minX>this.width+padding||maxY<-padding||minY>this.height+padding)continue;
      out.push({points,color:f.color,depth:depth/points.length,ground:top<=.17,top,bounds:{left:minX,top:minY,right:maxX,bottom:maxY}});
    }
    return out.sort((a,b)=>a.ground!==b.ground?(a.ground?-1:1):a.ground?a.top-b.top:b.depth-a.depth);
  }
}

export function character(person,time){
  const posePhase=person.posePhase??animationPhase(person,time);
  return buildCharacter(Mesh,hash,{...person,posePhase},time);
}

// These two oaks stay separate from the trees assigned to working companions.
const ADVENTURE_SPAWNS = [
  {key:'oak-by-market',kind:'oak',name:'Oak',x:-4,z:12},
  {key:'oak-by-lane',kind:'oak',name:'Oak',x:-3,z:16.5},
  {key:'giant-rat',kind:'rat',name:'Giant rat',x:2.2,z:15},
  {key:'goblin',kind:'goblin',name:'Goblin',x:5.3,z:11.8},
];
const ADVENTURE_TYPES = {
  oak: {height:3.8,reach:1.40,maxHp:0,cooldown:20,xp:25},
  rat: {height:.85,reach:1.05,maxHp:5,cooldown:14,xp:12},
  goblin: {height:1.62,reach:1.20,maxHp:8,cooldown:14,xp:20},
};
const PLAYER_MAX_HP=10;
const progressCount=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const savedHp=value=>Number.isSafeInteger(value)?clamp(value,1,PLAYER_MAX_HP):PLAYER_MAX_HP;

// Called after a competing writer commits. Only replay events since our last
// successful save. In particular, a paused view can still display an old stump.
export function mergeAdventureProgress(base,local,current,now=Date.now()){
  if(base?.version!==1)base={};
  if(local?.version!==1)local=base;
  if(current?.version!==1)current={};
  const mergeCount=(before,mine,theirs)=>Math.min(Number.MAX_SAFE_INTEGER,
    progressCount(theirs)+Math.max(0,progressCount(mine)-progressCount(before)));
  const merged={version:1,respawns:{},depletions:{}};
  for(const key of ['logs','woodXp','combatXp']){
    merged[key]=mergeCount(base[key],local[key],current[key]);
  }
  merged.hp=clamp(savedHp(current.hp)+savedHp(local.hp)-savedHp(base.hp),1,PLAYER_MAX_HP);
  for(const {key,kind} of ADVENTURE_SPAWNS){
    const before=progressCount(base.depletions?.[key]);
    const mine=progressCount(local.depletions?.[key]);
    const count=mergeCount(before,mine,current.depletions?.[key]);
    if(count)merged.depletions[key]=count;
    const baseDue=progressCount(base.respawns?.[key]);
    const localDue=progressCount(local.respawns?.[key]);
    const reward=kind==='oak'?'logs':'combatXp';
    // Older snapshots have no per-target count. An expired deadline can only
    // represent a new harvest if this view also earned the corresponding reward.
    const newLegacyEvent=!local.depletions&&baseDue<=now
      &&progressCount(local[reward])>progressCount(base[reward]);
    const localEvent=mine>before||!baseDue||newLegacyEvent;
    const until=Math.max(progressCount(current.respawns?.[key]),localEvent?localDue:0);
    if(until>now)merged.respawns[key]=until;
  }
  return merged;
}

class Adventure {
  constructor() {
    this.entities=ADVENTURE_SPAWNS.map(spawn=>{
      const type=ADVENTURE_TYPES[spawn.kind];
      return {...spawn,height:type.height,maxHp:type.maxHp,hp:type.maxHp,yaw:Math.PI,
        activity:'idle',posePhase:0,respawnAt:0,respawnBy:0,depletions:0};
    });
    this.targetKey=null;
    this.turn=null;
    this.landed=false;
    this.startedAt=0;
    this.exchange=0;
    this.nextHeal=0;
    this.wallClockOffset=0;
    this.message='';
    this.messageUntil=0;
    this.hp=this.maxHp=PLAYER_MAX_HP;
    this.woodXp=0;
    this.combatXp=0;
    this.logs=0;
    this.revision=0;
  }
  say(text,time) {
    this.message=text;
    this.messageUntil=time+6;
  }
  step(sim) {
    const now=sim.time,wallNow=Date.now()+this.wallClockOffset;
    if(sim.player.hit&&now>=sim.player.hitUntil)sim.player.hit=0;
    for(const e of this.entities){
      if(e.hit&&now>=e.hitUntil)e.hit=0;
      if(e.respawnAt&&(now>=e.respawnAt||wallNow>=e.respawnBy)){
        e.activity='idle';e.hp=e.maxHp;e.respawnAt=0;e.respawnBy=0;this.revision++;
      }
      e.posePhase=e.activity==='attack'
        ?clamp((now-this.startedAt)/MOTION.attack.seconds,0,1-Number.EPSILON)
        :(now*.55+(e.kind==='rat'?.4:0))%1;
    }
    if(!this.targetKey){
      if(now>=this.messageUntil)this.message='';
      if(this.hp<this.maxHp&&now>=this.nextHeal){
        this.hp++;this.nextHeal=now+8;this.revision++;
      }
      return;
    }
    if(sim.path.length)return;
    const e=this.entities.find(item=>item.key===this.targetKey);
    if(distance(sim.player,e)>ADVENTURE_TYPES[e.kind].reach+.12){sim.cancelAdventure();return;}
    sim.player.yaw=Math.atan2(e.x-sim.player.x,e.z-sim.player.z);
    sim.player.moving=false;
    if(!this.turn){
      this.exchange=0;
      if(e.kind==='oak'){
        this.turn='chop';this.startedAt=now;
        sim.player.activity='wood';sim.player.actionStartedAt=now;
        this.say('Chopping the oak…',now);
      }else{
        e.yaw=Math.atan2(sim.player.x-e.x,sim.player.z-e.z);
        this.startTurn(sim,e,'player');
        this.say('Facing the '+e.name.toLowerCase()+'. Walk away to retreat.',now);
      }
    }
    const elapsed=now-this.startedAt;
    if(this.turn==='chop'){
      // The axe meets the trunk halfway through each swing.
      if(elapsed>=2.5*MOTION.wood.seconds){
        this.logs++;this.woodXp+=ADVENTURE_TYPES.oak.xp;
        this.finish(sim,e,'stump','Oak felled. +1 oak log · +25 Woodcutting XP');
      }
      return;
    }
    if(!this.landed&&elapsed>=MOTION.attack.seconds/2){
      this.landed=true;
      const roll=hash(e.key+'/'+this.combatXp+'/'+this.exchange);
      if(this.turn==='player'){
        const damage=Math.min(e.hp,2+roll%3);
        e.hp-=damage;
        e.hit=damage;e.hitUntil=now+.7;
        this.say('You hit the '+e.name.toLowerCase()+' for '+damage+'.',now);
        if(e.hp===0){
          const xp=ADVENTURE_TYPES[e.kind].xp;this.combatXp+=xp;
          this.finish(sim,e,'hidden',e.name+' defeated. +'+xp+' Combat XP');
          return;
        }
      }else{
        const damage=Math.min(this.hp,1+roll%(e.kind==='rat'?2:3));
        this.hp-=damage;this.revision++;
        sim.player.hit=damage;sim.player.hitUntil=now+.7;
        this.nextHeal=now+8;
        this.say(e.name+' hits you for '+damage+'.',now);
        if(this.hp===0){
          sim.cancelAdventure();
          Object.assign(sim.player,{x:0,z:12,yaw:Math.PI,moving:false,hit:0});
          this.hp=this.maxHp;
          this.say('You recover at the commons.',now);
          return;
        }
      }
    }
    if(elapsed>=MOTION.attack.seconds){
      this.exchange++;
      this.startTurn(sim,e,this.turn==='player'?'creature':'player');
    }
  }
  startTurn(sim,e,turn) {
    this.turn=turn;this.startedAt=sim.time;this.landed=false;
    e.activity=turn==='creature'?'attack':'idle';
    e.posePhase=0;
    sim.player.activity=turn==='player'?'attack':'idle';
    sim.player.actionStartedAt=sim.time;
  }
  finish(sim,e,activity,message) {
    sim.cancelAdventure();
    const seconds=ADVENTURE_TYPES[e.kind].cooldown;
    e.hp=0;e.activity=activity;e.respawnAt=sim.time+seconds;
    e.respawnBy=Date.now()+this.wallClockOffset+seconds*1000;
    e.depletions++;
    this.revision++;
    this.say(message,sim.time);
  }
}

export class Simulation {
  constructor(){
    this.world=makeWorld();this.npcs=new Map();this.player={key:'player',x:0,z:12,yaw:Math.PI,player:true,activity:'idle',moving:false};
    this.path=[];this.targetKey=null;this.time=0;this.arrived=null;this.revision='';this.wasStale=false;
    this.adventure=new Adventure();
    for(const e of this.adventure.entities){
      if(e.kind==='oak')this.world.obstacles.push({x:e.x,z:e.z,w:.8,d:.8});
    }
    // Cache half-unit navigation cells as a walk needs them. Preparing every
    // cell at startup can exhaust the host's per-callback time budget.
    this.gridBlocked=new Uint8Array(81*77);
    const places=[];
    this.stations=Object.fromEntries(SKILLS.map(job=>[job,STATIONS[job].filter(p=>{
      if(this.blocked(p.x,p.z)||places.some(other=>distance(other,p)<.75))return false;
      places.push(p);return true;
    })]));
    this.commons=[];
    for(const [r,count] of [[3.4,12],[6,24],[8,28],[9.5,36],[11,44],[13,52],[15,60],[17,64]])for(let i=0;i<count;i++){
      const angle=i*TAU/count+.18,x=Math.cos(angle)*r,z=3+Math.sin(angle)*r;
      if(!this.blocked(x,z))this.commons.push({x,z,faceX:0,faceZ:3});
    }
  }
  blocked(x,z){
    if(x<-20||x>20||z<-19||z>19)return true;
    if(x>-18.8&&x<-13.4&&!(z>1.9&&z<4.1))return true;
    return this.world.obstacles.some(r=>Math.abs(x-r.x)<r.w/2+.18&&Math.abs(z-r.z)<r.d/2+.18);
  }
  cellBlocked(x,z){
    if(x< -40||x>40||z< -38||z>38)return true;
    const index=(z+38)*81+x+40;
    if(this.gridBlocked[index]===0)this.gridBlocked[index]=this.blocked(x*.5,z*.5)?2:1;
    return this.gridBlocked[index]===2;
  }
  clearSegment(a,b){
    const steps=Math.max(1,Math.ceil(distance(a,b)/.12));
    for(let i=1;i<=steps;i++){
      const t=i/steps;
      if(this.blocked(a.x+(b.x-a.x)*t,a.z+(b.z-a.z)*t))return false;
    }
    return true;
  }
  findPath(start,end){
    const grid=.5,key=(x,z)=>x+','+z;
    // An actor usually stands between grid nodes at a station. Choose an
    // accessible anchor on the same side of the obstacle for both endpoints.
    const anchor=(p,exact)=>{
      const cx=Math.round(p.x/grid),cz=Math.round(p.z/grid);
      const reachable=(x,z)=>!this.cellBlocked(x,z)&&(!exact||this.clearSegment(p,{x:x*grid,z:z*grid}));
      if(reachable(cx,cz))return [cx,cz];
      let best=null;
      for(let dx=-4;dx<=4;dx++)for(let dz=-4;dz<=4;dz++){
        const x=cx+dx,z=cz+dz,d=Math.hypot(x*grid-p.x,z*grid-p.z);
        if((!best||d<best.d)&&reachable(x,z))best={x,z,d};
      }
      return best?[best.x,best.z]:null;
    };
    const exactEnd=!this.blocked(end.x,end.z),begin=anchor(start,true),goal=anchor(end,exactEnd);
    if(!begin||!goal)return [];
    const [sx,sz]=begin;
    const first=key(sx,sz),last=key(...goal),open=[{x:sx,z:sz,g:0,f:0}],cost=new Map([[first,0]]),parent=new Map(),closed=new Set();
    let found=false;
    for(let n=0;open.length&&n<7000;n++){
      let index=0;for(let i=1;i<open.length;i++)if(open[i].f<open[index].f)index=i;
      const a=open.splice(index,1)[0],k=key(a.x,a.z);if(closed.has(k))continue;if(k===last){found=true;break;}closed.add(k);
      for(let [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
        const x=a.x+dx,z=a.z+dz,nk=key(x,z);if(closed.has(nk)||this.cellBlocked(x,z))continue;
        if(dx&&dz&&(this.cellBlocked(a.x,z)||this.cellBlocked(x,a.z)))continue;
        const g=a.g+(dx&&dz?1.414:1);if(g>=(cost.get(nk)??Infinity))continue;
        cost.set(nk,g);parent.set(nk,k);open.push({x,z,g,f:g+Math.hypot(x-goal[0],z-goal[1])});
      }
    }
    if(!found)return [];
    const out=[];for(let k=last;k!==first;k=parent.get(k)){if(!k)return [];const [x,z]=k.split(',').map(Number);out.push({x:x*grid,z:z*grid});}
    out.reverse();
    const firstPoint={x:sx*grid,z:sz*grid};
    if(distance(start,firstPoint)>.00001)out.unshift(firstPoint);
    if(exactEnd&&distance(out[out.length-1]||start,end)>.00001)out.push({x:end.x,z:end.z});
    return out;
  }
  sync(agents,stale=false){
    const sorted=agents.filter(a=>a.mapVisible!==false).sort((a,b)=>a.key.localeCompare(b.key));
    const revision=JSON.stringify(sorted.map(a=>[a.key,a.status,a.name,a.kind,a.host]))+stale;
    if(revision===this.revision)return;
    this.revision=revision;this.wasStale=stale;
    const assigned=new Map(),occupied=Object.fromEntries([...SKILLS,'commons'].map(g=>[g,new Set()]));
    const reserve=(key,group,slot)=>{assigned.set(key,{group,slot});occupied[group].add(slot);};
    // Existing workers keep their real workstation when a peer joins, changes
    // title, or finishes. Free stations are balanced across the five skills.
    for(const a of sorted){
      const previous=this.npcs.get(a.key);
      if(!previous)continue;
      const working=!stale&&a.status==='working',group=previous.slotGroup;
      if(working?this.stations[group]?.[previous.slot]:group==='commons')reserve(a.key,group,previous.slot);
    }
    // Returning from a stale observation or a brief idle spell restores the
    // previous station when it is still free, without displacing its new user.
    for(const a of sorted){
      if(assigned.has(a.key)||stale||a.status!=='working')continue;
      const remembered=this.npcs.get(a.key)?.lastWork;
      if(remembered&&!occupied[remembered.group].has(remembered.slot))reserve(a.key,remembered.group,remembered.slot);
    }
    for(const a of sorted){
      if(assigned.has(a.key)||stale||a.status!=='working')continue;
      const start=hash(a.key)%SKILLS.length;
      const jobs=SKILLS.map((_,i)=>SKILLS[(start+i)%SKILLS.length])
        .filter(job=>occupied[job].size<this.stations[job].length)
        .sort((a,b)=>occupied[a].size-occupied[b].size);
      if(jobs.length){
        const job=jobs[0];let slot=0;
        while(occupied[job].has(slot))slot++;
        reserve(a.key,job,slot);
      }
    }
    for(const a of sorted){
      if(!assigned.has(a.key)){
        let slot=0;while(occupied.commons.has(slot))slot++;
        reserve(a.key,'commons',slot);
      }
      const {group,slot}=assigned.get(a.key);
      const activity=group!=='commons'?group:stale?'unknown':a.status==='working'?'waiting':a.status;
      const dest=group==='commons'?this.commons[slot%this.commons.length]:this.stations[group][slot];
      let p=this.npcs.get(a.key);
      if(!p){
        p={x:dest.x,z:dest.z,moving:false,path:[]};this.npcs.set(a.key,p);
      }else if(p.dest!==dest){
        p.path=this.findPath(p,dest);
      }
      Object.assign(p,a,{activity,dest,slot,slotGroup:group,guildClass:classFor(a.kind),height:heightFor(a.kind)});
      if(group!=='commons')p.lastWork={group,slot};
      if(!p.path.length)p.yaw=Math.atan2(dest.faceX-p.x,dest.faceZ-p.z);
    }
    for(const key of this.npcs.keys())if(!assigned.has(key))this.npcs.delete(key);
    if(this.targetKey&&!this.npcs.has(this.targetKey)){this.targetKey=null;this.path=[];}
  }
  interact(key){
    const a=this.adventure,e=a.entities.find(item=>item.key===key);
    if(!e||e.activity==='hidden')return false;
    if(a.targetKey===key)return true;
    this.cancelAdventure();this.stopDance();
    this.targetKey=null;this.arrived=null;this.path=[];
    if(e.activity==='stump'){a.say('The oak is regrowing.',this.time);return false;}
    const reach=ADVENTURE_TYPES[e.kind].reach;
    const angle=Math.atan2(this.player.x-e.x,this.player.z-e.z);
    for(const turn of [0,1,-1,2,-2,3,-3,4]){
      const side=angle+turn*Math.PI/4,dx=Math.sin(side),dz=Math.cos(side);
      const goal={x:e.x+dx*reach,z:e.z+dz*reach};
      // Keep a clear line from the tool to the outside face of the trunk.
      const edge=e.kind==='oak'?{x:e.x+dx*.85,z:e.z+dz*.85}:e;
      if(this.blocked(goal.x,goal.z)||!this.clearSegment(goal,edge))continue;
      if(distance(this.player,goal)>.08){
        const path=this.findPath(this.player,goal);
        if(!path.length)continue;
        this.path=path;
      }
      a.targetKey=key;
      a.say((e.kind==='oak'?'Approaching the oak':'Approaching the '+e.name.toLowerCase())+'…',this.time);
      return true;
    }
    a.say('There is no clear path to the '+e.name.toLowerCase()+'.',this.time);
    return false;
  }
  cancelAdventure(){
    const a=this.adventure;
    if(!a.targetKey)return;
    const e=a.entities.find(item=>item.key===a.targetKey);
    e.activity='idle';e.hp=e.maxHp;
    a.targetKey=null;a.turn=null;a.message='';
    this.path=[];this.player.moving=false;this.player.activity='idle';
    delete this.player.actionStartedAt;
  }
  saveAdventure(now=Date.now()){
    const {logs,woodXp,combatXp,hp,entities}=this.adventure;
    const respawns={},depletions={};
    for(const e of entities){
      // A hidden view stops stepping. Its previous deadline still applies
      // when another action or a delayed writer triggers a save.
      const until=Math.min(e.respawnBy,now+Math.round((e.respawnAt-this.time)*1000));
      if(until>now)respawns[e.key]=until;
      if(e.depletions)depletions[e.key]=e.depletions;
    }
    return {version:1,logs,woodXp,combatXp,hp,respawns,depletions};
  }
  restoreAdventure(saved,now=Date.now()){
    if(!saved||saved.version!==1)return false;
    this.cancelAdventure();
    this.adventure.nextHeal=this.time+8;
    return this.reconcileAdventure(saved,now);
  }
  reconcileAdventure(saved,now=Date.now()){
    if(!saved||saved.version!==1)return false;
    const a=this.adventure;
    a.wallClockOffset=now-Date.now();
    for(const key of ['logs','woodXp','combatXp']){
      a[key]=progressCount(saved[key]);
    }
    const hp=savedHp(saved.hp);
    if(a.hp!==hp)a.nextHeal=this.time+8;
    a.hp=hp;
    for(const e of a.entities){
      const until=saved.respawns?.[e.key];
      const remaining=Number.isFinite(until)?clamp((until-now)/1000,0,ADVENTURE_TYPES[e.kind].cooldown):0;
      e.depletions=progressCount(saved.depletions?.[e.key]);
      if(a.targetKey===e.key){
        if(!remaining)continue;
        this.cancelAdventure();
      }
      e.respawnAt=remaining?this.time+remaining:0;
      e.respawnBy=remaining?now+Math.round(remaining*1000):0;
      e.hp=remaining?0:e.maxHp;
      e.activity=remaining?(e.kind==='oak'?'stump':'hidden'):'idle';
    }
    a.revision++;
    return true;
  }
  dance(){
    this.cancelAdventure();
    this.path=[];this.targetKey=null;this.arrived=null;
    this.player.moving=false;this.player.activity='dance';this.player.danceStartedAt=this.time;
    return true;
  }
  stopDance(){
    this.player.activity='idle';delete this.player.danceStartedAt;
  }
  walk(dest){this.cancelAdventure();this.stopDance();this.targetKey=null;this.arrived=null;this.path=this.findPath(this.player,dest);return this.path.length>0;}
  approach(key){
    const p=this.npcs.get(key);if(!p)return false;
    this.cancelAdventure();this.stopDance();
    this.arrived=null;
    if(distance(p,this.player)<2.6&&this.clearSegment(this.player,p)){this.path=[];this.targetKey=key;return true;}
    const angle=Math.atan2(this.player.x-p.x,this.player.z-p.z);
    // Try the near side first. A bank, crop bed or anvil can sit between
    // the player and the companion, so check an actual walking approach.
    for(const turn of [0,1,-1,2,-2,3,-3,4]){
      const a=angle+turn*Math.PI/4,goal={x:p.x+Math.sin(a)*1.25,z:p.z+Math.cos(a)*1.25};
      if(this.blocked(goal.x,goal.z)||!this.clearSegment(goal,p))continue;
      const path=this.findPath(this.player,goal);
      if(path.length){this.path=path;this.targetKey=key;return true;}
    }
    this.path=[];this.targetKey=null;return false;
  }
  move(p,path,dt,speed){
    let left=dt*speed;p.moving=!!path.length;
    while(path.length&&left>0){const target=path[0],d=distance(p,target);p.yaw=Math.atan2(target.x-p.x,target.z-p.z);
      if(d<=left){p.x=target.x;p.z=target.z;left-=d;path.shift();}else{p.x+=(target.x-p.x)*left/d;p.z+=(target.z-p.z)*left/d;left=0;}}
  }
  step(dt,keys={},yaw=0){
    dt=clamp(dt,0,.1);this.time+=dt;
    const forward=(keys.up?1:0)-(keys.down?1:0),side=(keys.right?1:0)-(keys.left?1:0);
    if(this.player.activity==='dance'&&(forward||side||this.time-this.player.danceStartedAt>=MOTION.dance.seconds))this.stopDance();
    if(forward||side){this.cancelAdventure();this.path=[];this.targetKey=null;this.arrived=null;const norm=Math.hypot(forward,side),speed=dt*4.2;
      const dx=(side*Math.cos(yaw)-forward*Math.sin(yaw))/norm*speed,dz=(-side*Math.sin(yaw)-forward*Math.cos(yaw))/norm*speed;
      if(!this.blocked(this.player.x+dx,this.player.z))this.player.x+=dx;
      if(!this.blocked(this.player.x,this.player.z+dz))this.player.z+=dz;
      this.player.yaw=Math.atan2(dx,dz);this.player.moving=true;
    }else this.move(this.player,this.path,dt,4.5);
    for(const p of this.npcs.values()){this.move(p,p.path,dt,2.4);if(!p.path.length){p.moving=false;p.yaw=Math.atan2(p.dest.faceX-p.x,p.dest.faceZ-p.z);}}
    if(this.targetKey&&!this.path.length){const p=this.npcs.get(this.targetKey);
      if(p&&distance(this.player,p)<2.6&&this.clearSegment(this.player,p)){this.arrived=p.key;this.player.yaw=Math.atan2(p.x-this.player.x,p.z-this.player.z);this.targetKey=null;}
      else if(p)this.approach(p.key);
    }
    this.adventure.step(this);
  }
  nearest(){return [...this.npcs.values()].filter(a=>distance(a,this.player)<2.8).sort((a,b)=>distance(a,this.player)-distance(b,this.player))[0]||null;}
}
