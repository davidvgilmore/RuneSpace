// Original RuneScape release years. These are cosmetic unlocks in the Guild.
export const EQUIPMENT_SLOTS=[
  {id:'head',label:'Head'},{id:'cape',label:'Cape'},{id:'torso',label:'Body'},
  {id:'weapon',label:'Weapon'},{id:'shield',label:'Shield'},{id:'legs',label:'Legs'},{id:'boots',label:'Feet'},
];
const item=(slot,id,name,year,detail)=>({slot,id,name,year,detail});
const title=s=>s[0].toUpperCase()+s.slice(1);
export const EQUIPMENT_ITEMS=[
  ...['blue','red','green','yellow','purple','white'].map(color=>
    item('head',color+'-partyhat',title(color)+' partyhat',2001,'A paper crown from the original Christmas crackers.')),
  item('head','santa-hat','Santa hat',2002,'A keepsake from the Christmas 2002 drop.'),
  ...['red','green','blue'].map(color=>
    item('head',color+'-halloween-mask',title(color)+' h’ween mask',2002,'A horned mask from the 2002 Halloween drop.')),
  item('cape','fire-cape','Fire cape',2005,'Molten lava from TzTok-Jad’s Fight Caves.'),
  item('cape','slayer-cape-t','Slayer cape (t)',2006,'Level 99 Slayer, trimmed for a second skill at 99.'),
  item('cape','cape-of-legends','Cape of Legends',2003,'The white cape of the Legends’ Guild.'),
  item('torso','dragon-chainbody','Dragon chainbody',2004,'Crimson mail coveted by Kalphite Queen hunters.'),
  item('torso','bandos-chestplate','Bandos chestplate',2007,'General Graardor’s one-shouldered strength armour.'),
  item('torso','dragon-platebody','Dragon platebody',2008,'Forged from the ruined pieces in While Guthix Sleeps.'),
  item('weapon','abyssal-whip','Abyssal whip',2005,'An abyssal demon’s lash. A signature Slayer drop.'),
  {...item('weapon','armadyl-godsword','Armadyl godsword',2007,'The winged God Wars blade wielded with both hands.'),twoHanded:true},
  item('weapon','dragon-scimitar','Dragon scimitar',2005,'The curved red blade of Monkey Madness.'),
  item('shield','elysian-spirit-shield','Elysian spirit shield',2008,'The Corporeal Beast’s spectral blue sigil.'),
  item('shield','divine-spirit-shield','Divine spirit shield',2008,'The emerald spirit shield from the Corporeal Beast.'),
  item('shield','dragonfire-shield','Dragonfire shield',2007,'A draconic visage forged onto an anti-dragon shield.'),
  item('shield','rune-defender','Rune defender',2006,'A rune parrying blade from the Warriors’ Guild.'),
  item('legs','bandos-tassets','Bandos tassets',2007,'General Graardor’s split plates and hanging tabard.'),
  item('legs','third-age-platelegs','3rd age platelegs',2006,'Pale silver armour from a rare Treasure Trails reward.'),
  item('legs','dragon-platelegs','Dragon platelegs',2005,'Crimson plate from the metal dragons of Brimhaven.'),
  item('boots','dragon-boots','Dragon boots',2007,'Red spiked boots from the God Wars spiritual mages.'),
  item('boots','ranger-boots','Ranger boots',2004,'The green boots prized by Treasure Trails hunters.'),
  item('boots','infinity-boots','Infinity boots',2006,'Enchanted footwear from the Mage Training Arena.'),
];
export const DEFAULT_LOADOUT=Object.freeze({
  head:'blue-partyhat',cape:'fire-cape',torso:'dragon-chainbody',weapon:'abyssal-whip',
  shield:'elysian-spirit-shield',legs:'bandos-tassets',boots:'dragon-boots',
});
const byId=new Map(EQUIPMENT_ITEMS.map(i=>[i.id,i]));
const valid=(slot,id)=>Object.hasOwn(DEFAULT_LOADOUT,slot)&&(id==='none'||byId.get(id)?.slot===slot);
export function normalizeLoadout(raw){
  const result={...DEFAULT_LOADOUT};
  for(const {id} of EQUIPMENT_SLOTS)if(valid(id,raw?.[id]))result[id]=raw[id];
  if(byId.get(result.weapon)?.twoHanded)result.shield='none';
  return result;
}
export function equipItem(raw,slot,id){
  const result=normalizeLoadout(raw);
  if(!valid(slot,id))return result;
  if(slot==='shield'&&id!=='none'&&byId.get(result.weapon)?.twoHanded)result.weapon='none';
  result[slot]=id;
  if(slot==='weapon'&&byId.get(id)?.twoHanded)result.shield='none';
  return result;
}
// Shields render last so translucent faces blend against the rest of the outfit.
export const PLAYER_PARTS=['legs','boots','torso','cape','head','weapon','shield'];
export function playerPartKey(slot,gear,pose){
  const grip=slot==='torso'&&byId.get(gear.weapon)?.twoHanded&&pose!=='dance'?':2h':'';
  return slot+':'+gear[slot]+grip;
}
export function equippedPartKeys(gear,pose){
  return PLAYER_PARTS.filter(slot=>gear[slot]!=='none'||!['weapon','shield','cape'].includes(slot))
    .map(slot=>playerPartKey(slot,gear,pose));
}

// Transparent portraits line up on a common camera and origin. The back view
// draws the cape over the cuirass and hides weapons carried in front of it.
export function previewLayers(gear,view){
  const rear=view==='back';
  const order=rear?['weapon','shield','legs','boots','torso','head','cape']:
    ['cape','legs','boots','torso','head','weapon','shield'];
  return order.filter(slot=>gear[slot]!=='none'||!['weapon','shield','cape'].includes(slot))
    .map(slot=>'mods/runespace/wardrobe/'+(rear?'back':'front')+'/'+playerPartKey(slot,gear,'idle').replaceAll(':','-')+'.png');
}
