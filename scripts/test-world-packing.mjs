import test from 'node:test';
import assert from 'node:assert/strict';
import {packFaces,polygonsOverlap} from '../layout/mods/runespace/world-packing.js';
import {Simulation,Camera,Mesh,character} from '../layout/mods/runespace/world-engine.js';

const box=(x,y,w,h,color)=>({points:[[x,y],[x+w,y],[x+w,y+h],[x,y+h]],color});
const inside=(p,face)=>{
  let sign=0;
  for(let i=0;i<face.points.length;i++){
    const a=face.points[i],b=face.points[(i+1)%face.points.length],cross=(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
    if(Math.abs(cross)<1e-8)continue;
    const current=Math.sign(cross);if(sign&&current!==sign)return false;sign=current;
  }
  return !!sign;
};
function paint(point,faces){
  let rgb=[0,0,0];
  for(const f of faces){
    const g=f.packingGeometry;
    if(g&&(point[0]<g.left||point[0]>g.right||point[1]<g.top||point[1]>g.bottom))continue;
    if(!inside(point,f))continue;
    const alpha=f.color.length===9?parseInt(f.color.slice(7,9),16)/255:1;
    rgb=rgb.map((v,i)=>v*(1-alpha)+parseInt(f.color.slice(1+i*2,3+i*2),16)*alpha);
  }
  return rgb;
}

test('SAT recognizes adjacent polygons without treating their boxes as overlap',()=>{
  const a={points:[[0,0],[10,0],[0,10]],color:'#ff0000'},b={points:[[10,0],[10,10],[0,10]],color:'#0000ff'};
  assert.equal(polygonsOverlap(a,b),false);
  assert.equal(polygonsOverlap(a,box(1,1,2,2,'#00ff00')),true);
  assert.equal(polygonsOverlap(box(0,0,10,10,'#fff000'),box(10,0,10,10,'#000fff')),false);
});

test('opaque batching may cross only disjoint intervening polygons',()=>{
  const faces=[box(0,0,4,4,'#ff0000'),box(9,0,4,4,'#0000ff'),box(2,2,4,4,'#ff0000')];
  assert.equal(packFaces(faces,20,20).length,2);
  const covered=[box(0,0,10,10,'#ff0000'),box(2,2,8,8,'#0000ff'),box(3,3,2,2,'#ff0000')];
  assert.equal(packFaces(covered,20,20).length,3);
});

test('translucent faces preserve repeated alpha compositing',()=>{
  const faces=[box(0,0,10,10,'#ff000080'),box(2,2,10,10,'#ff000080'),box(20,0,4,4,'#00ff00'),box(3,3,4,4,'#0000ff80')];
  const packed=packFaces(faces,30,30).flatMap(g=>g.faces);
  for(const p of [[3.5,3.5],[1.5,1.5],[8.5,8.5],[22,2]])assert.deepEqual(paint(p,packed),paint(p,faces));
});

test('full guild scene preserves sampled painter output at multiple camera angles',()=>{
  const sim=new Simulation();sim.sync(Array.from({length:28},(_,i)=>({key:`host/session-${i}`,name:`Session ${i}`,host:i%3?'local':'remote',kind:i%2?'Claude':'Codex',status:i<8?'working':'idle'})));
  const mesh=new Mesh();mesh.faces.push(...sim.world.mesh.faces);
  for(const p of [...sim.npcs.values(),sim.player])mesh.transformed(character(p,2.25),p.x,p.z,p.yaw);
  let seed=924012;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(const yaw of [.18,1.1,2.2]){
    const faces=new Camera(1280,740,{x:0,z:2},yaw,1.1).faces(mesh),groups=packFaces(faces,1280,740),packed=groups.flatMap(g=>g.faces);
    assert.ok(groups.length<faces.length*.55,`${groups.length}/${faces.length}`);
    for(let i=0;i<2200;i++){
      const p=[random()*1280,random()*740];assert.deepEqual(paint(p,packed),paint(p,faces),`${yaw} ${p}`);
    }
  }
});
