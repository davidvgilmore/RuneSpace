import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {DEFAULT_LOADOUT,EQUIPMENT_SLOTS,EQUIPMENT_ITEMS,normalizeLoadout,equipItem,equippedPartKeys,previewLayers} from '../layout/mods/runespace/equipment.js';
import {character} from '../layout/mods/runespace/world-engine.js';

test('existing players keep their outfit and damaged saves recover slot by slot',()=>{
  assert.deepEqual(normalizeLoadout(null),DEFAULT_LOADOUT);
  assert.deepEqual(normalizeLoadout({head:'white-partyhat',boots:'white-partyhat',torso:null}),
    {...DEFAULT_LOADOUT,head:'white-partyhat'});
  assert.deepEqual(equipItem(null,'unknown','none'),DEFAULT_LOADOUT);
  assert.deepEqual(equipItem(null,'shield','dragon-scimitar'),DEFAULT_LOADOUT);
  assert.equal(new Set(EQUIPMENT_ITEMS.map(item=>item.id)).size,EQUIPMENT_ITEMS.length);
});
test('the most recent main or off-hand choice wins and survives a saved round trip',()=>{
  const initial=equipItem(null,'head','purple-partyhat');
  const sword=equipItem(initial,'weapon','armadyl-godsword');
  assert.equal(sword.shield,'none');assert.equal(initial.shield,DEFAULT_LOADOUT.shield);
  assert.equal(sword.head,'purple-partyhat');
  assert.deepEqual(normalizeLoadout(JSON.parse(JSON.stringify(sword))),sword);
  assert.deepEqual(normalizeLoadout({...sword,shield:'divine-spirit-shield'}),sword);
  assert.ok(equippedPartKeys(sword,'walk').includes('torso:dragon-chainbody:2h'));
  assert.ok(equippedPartKeys(sword,'dance').includes('torso:dragon-chainbody'));
  const shield=equipItem(sword,'shield','divine-spirit-shield');
  assert.equal(shield.weapon,'none');assert.equal(shield.shield,'divine-spirit-shield');
  assert.equal(equipItem(sword,'shield','none').weapon,'armadyl-godsword');
});
test('all slots can be emptied and all wardrobe items have icons and animated world geometry',()=>{
  const bare=EQUIPMENT_SLOTS.reduce((g,{id})=>equipItem(g,id,'none'),null);
  assert.deepEqual(equippedPartKeys(bare,'idle'),['legs:none','boots:none','torso:none','head:none']);
  for(const {id,slot} of EQUIPMENT_ITEMS){
    assert.ok(existsSync(new URL('../layout/mods/runespace/preview/'+id+'.png',import.meta.url)),id);
    const gear=equipItem(bare,slot,id);
    for(const pose of ['idle','walk','dance']){
      const topology=[0,.4,.8].map(phase=>{
        const mesh=character({key:'player',player:true,loadout:gear,equipmentPart:slot,moving:pose==='walk',activity:pose,posePhase:phase},0);
        assert.ok(mesh.faces.length>0 && mesh.faces.every(f=>f.points.every(p=>p.every(Number.isFinite))),id);
        return mesh.faces.map(f=>f.points.length);
      });
      assert.deepEqual(topology[0],topology[1],id);assert.deepEqual(topology[0],topology[2],id);
    }
  }
});

test('both wardrobe views have matching assets for every selection and two-handed stance',()=>{
  const bare=Object.fromEntries(EQUIPMENT_SLOTS.map(({id})=>[id,'none']));
  const outfits=[bare,...EQUIPMENT_ITEMS.map(i=>equipItem(DEFAULT_LOADOUT,i.slot,i.id))];
  for(const torso of [...EQUIPMENT_ITEMS.filter(i=>i.slot==='torso').map(i=>i.id),'none']){
    outfits.push({...bare,torso,weapon:'armadyl-godsword'});
  }
  for(const outfit of outfits)for(const view of ['front','back']){
    const paths=previewLayers(outfit,view);
    assert.equal(paths.length,equippedPartKeys(outfit,'idle').length);
    for(const path of paths)assert.ok(existsSync(new URL('../layout/'+path,import.meta.url)),path);
  }
});
