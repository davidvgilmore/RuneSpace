import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh, STATIONS, hash } from '../layout/mods/runespace/world-engine.js';
import { NPC_KINDS, WORK_CYCLES, buildCharacter, buildWorldArt, classFor, playerDancePose } from '../layout/mods/runespace/world-art.js';

class Materials extends Mesh {
  face(points,color) { super.face(points,color,false); }
}
const world = buildWorldArt(Materials,hash).mesh;
const sample = (job,phase,kind='Claude') =>
  buildCharacter(Materials,hash,{key:'sample',host:'local',kind,moving:job==='walk',activity:job,posePhase:phase},0);
const only = (mesh,colors) => mesh.faces.filter(f=>colors.includes(f.color));
const difference=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const bounds=(points,axis)=>[Math.min(...points.map(p=>p[axis])),Math.max(...points.map(p=>p[axis]))];

test('front-facing characters hold their main weapon on viewer-left and shields on viewer-right',()=>{
  const check=(mesh,colors,side)=>{
    const points=only(mesh,colors).flatMap(f=>f.points);
    assert.ok(points.length>0,'missing equipment '+colors);
    assert.ok(points.every(p=>side*p[0]>0),'equipment crossed to the wrong side '+colors);
  };
  const warrior=sample('idle',0,'OpenCode');
  check(warrior,['#6d4c35'],-1);check(warrior,['#56778b','#7896a6'],1);
  check(sample('idle',0,'Codex'),['#86dadb'],-1);
  check(sample('idle',0,'Claude'),['#ad7841'],-1);
  check(sample('idle',0,'Pi'),['#805a38'],-1);
  for(const activity of ['idle','walk','dance'])for(let frame=0;frame<40;frame++){
    const mesh=buildCharacter(Materials,hash,{player:true,activity,moving:activity==='walk',posePhase:frame/40},0);
    check(mesh,['#833c37'],-1);check(mesh,['#b8bcc2','#d5d0ce'],1);
  }
});

test('OpenCode warriors and Pi druids sling their own gear to use the station tools',()=>{
  const tools={wood:'#8e9da0',mine:'#9daaaa',smith:'#82918e',fish:'#d8623c',farm:'#b7beb0'};
  for(const [kind,job,gear] of [
    ['OpenCode','Warrior',['#6d4c35','#56778b']],
    ['Pi','Druid',['#805a38']],
  ]){
    assert.equal(classFor(kind),job);
    assert.ok(NPC_KINDS.includes(kind));
    for(const activity of ['walk',...Object.keys(tools)]){
      const mesh=sample(activity,.5,kind);
      const gearPoints=only(mesh,gear).flatMap(f=>f.points);
      assert.ok(gearPoints.length && gearPoints.every(p=>p[2]<0),kind+' stows gear for '+activity);
      if(activity==='walk')continue;
      const movingTool=only(mesh,[tools[activity]]);
      assert.ok(movingTool.length,kind+' has a tool for '+activity);
      assert.deepEqual(movingTool,only(sample(activity,.5,'Codex'),[tools[activity]]));
      assert.notDeepEqual(movingTool,only(sample(activity,.20,kind),[tools[activity]]));
    }
  }
});

test('the classic Dance pumps both forearms together over one kicking leg per phrase',()=>{
  const neutral=playerDancePose(0);
  assert.deepEqual(neutral.right,[-.34,.90,.085]);
  for(const [half,kickingLeg] of [[0,1],[.5,0]]){
    const support=1-kickingLeg;
    for(let i=0;i<5;i++){
      const phase=half+.025+i*.10,raised=playerDancePose(phase);
      for(const [j,wrist] of [raised.right,raised.left].entries()){
        assert.ok(wrist[1]-raised.elbows[j][1]>.25);
        assert.ok(raised.elbows[j][1]>1.22);
      }
      assert.ok(raised.legs[kickingLeg].ankle[1]>.28);
      assert.deepEqual(raised.legs[support].ankle,neutral.legs[support].ankle);
      if(i===4)continue;
      const reach=playerDancePose(phase+.05);
      for(const [j,wrist] of [reach.right,reach.left].entries()){
        assert.ok(Math.abs(wrist[1]-reach.elbows[j][1])<.06);
        assert.ok(wrist[2]-reach.elbows[j][2]>.14);
      }
      assert.ok(Math.abs(reach.legs[kickingLeg].ankle[0])>Math.abs(raised.legs[kickingLeg].ankle[0]));
    }
    const toe=playerDancePose(half+.075).legs[kickingLeg].ankle;
    assert.ok(half ? toe[2]>.25 : toe[2]<-.06);
  }
  for(const phase of [0,.5,1]){
    const pose=playerDancePose(phase);
    assert.deepEqual(pose.right,neutral.right);
    assert.deepEqual(pose.legs,neutral.legs);
    assert.deepEqual(pose.torso([0,1.32,0]),neutral.torso([0,1.32,0]));
  }
});

// A segment against a resource triangle, including its boundary.
function intersects(from,to,a,b,c) {
  const line=difference(to,from),e1=difference(b,a),e2=difference(c,a);
  const h=cross(line,e2),det=dot(e1,h);
  if(Math.abs(det)<1e-9)return false;
  const s=difference(from,a),u=dot(s,h)/det;
  if(u<0 || u>1)return false;
  const q=cross(s,e1),v=dot(line,q)/det,t=dot(e2,q)/det;
  return v>=0 && u+v<=1 && t>=0 && t<=1;
}
function actualContact(parts,faces,station) {
  const yaw=Math.atan2(station.faceX-station.x,station.faceZ-station.z),c=Math.cos(yaw),s=Math.sin(yaw);
  const worldPoint=([x,y,z])=>[station.x+c*x+s*z,y,station.z-s*x+c*z];
  const near=faces.filter(f=>f.points.some(p=>Math.hypot(p[0]-station.faceX,p[2]-station.faceZ)<2));
  for(const f of parts){
    const points=f.points.map(worldPoint);
    for(let i=0;i<points.length;i++)for(const resource of near)for(let j=1;j<resource.points.length-1;j++){
      if(intersects(points[i],points[(i+1)%points.length],resource.points[0],resource.points[j],resource.points[j+1]))return true;
    }
  }
  return false;
}

test('the animated tool reaches the actual station mesh at the strike',()=>{
  for(const [job,phase,tool,resource] of [
    ['wood',.50,['#8e9da0','#cdd5c9','#cbd4ca'],['#745131']],
    ['mine',.50,['#9daaaa','#a4afab','#d4dbcc'],['#858c85','#a4aaa0','#8f978f']],
    ['smith',.50,['#82918e','#b8c4b9'],['#ce7842']],
    ['farm',.375,['#b7beb0'],['#6d5537','#795a39']],
  ]){
    const resourceFaces=only(world,resource);
    const strike=only(sample(job,phase),tool), lifted=only(sample(job,job==='farm'?.19:.375),tool);
    for(const station of STATIONS[job])assert.equal(actualContact(lifted,resourceFaces,station),false,job+' tool intersects during windup');
    const contacts=STATIONS[job].map(station=>actualContact(strike,resourceFaces,station));
    assert.equal(contacts.filter(Boolean).length,contacts.length,job+' missed slots '+contacts.flatMap((v,i)=>v?[]:[i]));
  }
});

test('fishing sends the float into the river and draws it back, farming pulls planted tines toward the feet',()=>{
  const floatBounds=(t,axis)=>bounds(only(sample('fish',t),['#eee3bd','#d8623c']).flatMap(f=>f.points),axis);
  assert.ok(floatBounds(.24,1)[0]>1);
  assert.ok(floatBounds(.50,1)[0]<.027 && floatBounds(.50,1)[1]>.12);
  const landing=floatBounds(.50,2);
  for(const st of STATIONS.fish){
    const sign=Math.sign(st.faceX-st.x);
    for(const reach of landing)assert.ok(st.x+sign*reach>-17.9&&st.x+sign*reach< -14.1);
  }
  assert.ok(floatBounds(.875,2)[1]<landing[0]-.5);
  const tines=t=>bounds(only(sample('farm',t),['#b7beb0']).flatMap(f=>f.points),2)[0];
  assert.ok(tines(.375)-tines(.6875)>.4);
});

test('each working class has stable finite geometry and planted feet across its entire baked loop',()=>{
  for(const kind of NPC_KINDS)for(const job of Object.keys(WORK_CYCLES).filter(s=>s!=='idle'&&s!=='walk')){
    const counts=new Set();
    for(let i=0;i<24;i++){
      const mesh=sample(job,i/24,kind);
      counts.add(mesh.faces.map(f=>f.points.length).join(','));
      assert.ok(mesh.faces.every(f=>f.points.every(p=>p.every(Number.isFinite))));
      const boots=only(mesh,['#655034']).flatMap(f=>f.points);
      assert.equal(bounds(boots,1)[0],.015);
    }
    assert.equal(counts.size,1,kind+' '+job);
  }
});
