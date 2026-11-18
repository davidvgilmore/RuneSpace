// Bake the same artwork used by the embedded view into triangle buffers for Metal.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {DEFAULT_LOADOUT,EQUIPMENT_ITEMS,PLAYER_PARTS,playerPartKey} from '../layout/mods/runespace/equipment.js';
import {Mesh,character,makeWorld,MOTION,PLAYER_IDLE_CLIP,clipFor} from '../layout/mods/runespace/world-engine.js';
import {NPC_KINDS,WORK_CYCLES,buildAdventureModel} from '../layout/mods/runespace/world-art.js';

const mod = new URL('../layout/mods/runespace/', import.meta.url);
const output = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('metal/', mod));
mkdirSync(output, {recursive:true});
const read = name => readFileSync(new URL(name,mod),'utf8');
function writeIfChanged(name,content) {
  const url=resolve(output,name);
  try {if (readFileSync(url,'utf8')===content) return;} catch (error) {if(error.code!=='ENOENT')throw error;}
  writeFileSync(url,content);
}

function triangles(mesh) {
  const vertices=[];
  const rgba=hex=>[1,3,5,7].map(offset=>parseInt(hex.slice(offset,offset+2)||'ff',16)/255);
  for (const {points,color,vertexColors} of mesh.faces) {
    const flat=rgba(color),corners=vertexColors?.map(rgba);
    for(let i=1;i<points.length-1;i++) {
      for (const k of [0,i,i+1]) vertices.push(...points[k],...(corners?.[k]??flat));
    }
  }
  return Buffer.from(new Float32Array(vertices).buffer).toString('base64');
}
const actors={};
for (const kind of NPC_KINDS) {
  for (const host of ['local','remote','other']) {
    const key=kind+'/'+host;
    for (const pose of Object.keys(WORK_CYCLES)) {
      const {frames,seconds}=MOTION[pose];
      for(let frame=0;frame<frames;frame++) {
        const posePhase=frame/frames;
        const person={kind,host,key,moving:pose==='walk',activity:pose,posePhase};
        actors[[kind,host,pose,frame].join(':')]=triangles(character(person,posePhase*seconds));
      }
    }
  }
}
for(const kind of ['oak','goblin','rat']){
  const frames=kind==='oak'?1:8;
  for(const activity of kind==='oak'?['idle','stump']:['idle','attack']){
    for(let i=0;i<frames;i++){
      const mesh=buildAdventureModel(Mesh,kind,activity,i/frames);
      actors[`Adventure:${kind}:${activity}:${i}`]=triangles(mesh);
    }
  }
}
// Bake one animated mesh per wearable, so swapping a slot never rebuilds a full
// outfit. Static poses share the same Metal buffer across animation frames.
const aliases={},seen=new Map();
for(const slot of PLAYER_PARTS){
  const items=EQUIPMENT_ITEMS.filter(item=>item.slot===slot).map(item=>item.id);
  if(!['weapon','shield','cape'].includes(slot))items.push('none');
  for(const id of items)for(const pose of ['idle','walk','dance','wood','attack']){
    // Every outfit borrows the same two-handed hatchet during woodcutting.
    if(pose==='wood'&&(slot==='shield'||slot==='weapon'&&id!==DEFAULT_LOADOUT.weapon))continue;
    const {frames,seconds}=clipFor({player:true},pose);
    const grips=slot==='torso'&&pose!=='dance'&&pose!=='wood'?['abyssal-whip','armadyl-godsword']:['abyssal-whip'];
    for(const grip of grips){
      const loadout={...DEFAULT_LOADOUT,weapon:grip,[slot]:id};
      const part=playerPartKey(slot,loadout,pose);
      for(let i=0;i<frames;i++){
        const posePhase=i/frames;
        const mesh=character({player:true,key:'player',moving:pose==='walk',activity:pose,loadout,
          equipmentPart:slot,posePhase},posePhase*seconds);
        if(!mesh.faces.length)throw Error('Missing equipment mesh: '+part);
        const key='Gear:'+part+':'+pose+':'+i,encoded=triangles(mesh);
        const digest=createHash('sha256').update(encoded).digest('hex'),existing=seen.get(digest);
        if(existing){aliases[key]=existing;continue;}
        seen.set(digest,key);actors[key]=encoded;
      }
    }
  }
}
writeIfChanged('assets.json',JSON.stringify({world:triangles(makeWorld().mesh),actors,aliases,motion:MOTION,playerIdle:PLAYER_IDLE_CLIP}));

// JavaScriptCore evaluates classic scripts. Scope the two ES modules separately
// so their helpers keep module-local names, and use the shared simulation verbatim.
const classic = source=>source.replace(/^export (?=(?:class|const|function) )/gm,'').replace(/^export\s*\{[^}]*\};?\s*$/gm,'');
const equipment=classic(read('equipment.js'));
const art=classic(read('world-art.js').replace(/^import .* from '\.\/equipment\.js';$/m,''));
const moduleSource=read('world-engine.js');
const imports=/^import\s*\{([^}]+)\}\s*from\s*['"]\.\/world-art\.js['"];?/m;
const artNames=moduleSource.match(imports)?.[1];
if(!artNames)throw Error('The simulation needs its declared world-art exports');
const engine=classic(moduleSource.replace(imports,''));
const gear='const {normalizeLoadout,equippedPartKeys}=(()=>{\n'+equipment+'\nreturn {normalizeLoadout,equippedPartKeys};})();\n';
const bundle=gear+'const {'+artNames+'}=(()=>{\n'+art+'\nreturn {'+artNames+'};})();\n'+engine+'\n'+read('metal/bridge.js');
writeIfChanged('engine.bundle.js',bundle);
console.log('Baked '+Object.keys(actors).length+' animation poses in '+output);
