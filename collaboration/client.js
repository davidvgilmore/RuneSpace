import {EQUIPMENT_ITEMS,EQUIPMENT_SLOTS} from '/world/equipment.js';
import {createGuildWorld} from './world.js';
import {createGuildMedia,nearbyIdentities} from './media.js';

import {createHerdrActions, readHostEntry, teamInvite} from './host-ui.js';

const $=id=>document.getElementById(id);
const sessionKey='runespace.team.session';
const saved=(key)=>{try{return sessionStorage.getItem(key);}catch{return null;}};
function remember(key,value){try{value===null?sessionStorage.removeItem(key):sessionStorage.setItem(key,value);}catch{}}
function inviteFrom(text) {
  const trimmed=text.trim();
  if(/^https?:\/\//i.test(trimmed)){
    try{return new URLSearchParams(new URL(trimmed).hash.slice(1)).get('invite')||'';}catch{return '';}
  }
  return trimmed;
}
const entry=readHostEntry(new URL(location.href),{getItem:saved,setItem:remember});
let invite=entry.invite;
if(entry.hadOwner)history.replaceState(null,'',entry.clean);
$('invite-field').hidden=!!invite;
$('name').value=saved('runespace.team.name')||'';
let credentials=null,socket=null,joining=false,attempt=0,retryTimer,sessionEpoch=0;
let nearby=new Set(),lastList='',mediaStarting=false,mediaActive=false,toastTimer,mediaEpoch=0;
function toast(message){$('toast').textContent=message;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').textContent='';},3200);}
function status(message,state){$('connection').textContent=message;$('connection').dataset.state=state;}
const herdr=createHerdrActions({session:()=>credentials,post,toast});
function worldVisible(inWorld){
  $('pack').hidden=!inWorld;$('gate').hidden=inWorld;$('leave').hidden=!inWorld;$('dock').hidden=!inWorld;
  $('roster').hidden=!inWorld;$('roster-toggle').hidden=!inWorld;$('invite').disabled=!invite;
}
function mediaStatus(message){
  $('media-note').textContent=message;
  if(message?.includes('disconnected')){mediaActive=false;$('retry-media').hidden=false;}
}
const media=createGuildMedia({tiles:$('media-tiles'),micButton:$('mic'),cameraButton:$('camera'),soundButton:$('sound'),onStatus:mediaStatus});
const world=createGuildWorld({canvas:$('world'),labels:$('labels'),onMove(move){
  if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'move',...move}));
},onAgent:agent=>herdr.chat(agent),onInspect:toast,onInventory:openPack,onAdventure(progress){
  $('adventure-note').textContent=progress.message;
  $('pack-hp').textContent=progress.hp+' / '+progress.maxHp;
  $('pack-logs').textContent=progress.logs;
  $('pack-wood').textContent=progress.woodXp+' XP';
  $('pack-combat').textContent=progress.combatXp+' XP';
}});
function openPack(){
  if(!credentials||!$('gate').hidden)return;
  const slots=$('pack-gear');
  if(!slots.children.length){
    for(const slot of EQUIPMENT_SLOTS){
      const label=document.createElement('label'),select=document.createElement('select');
      label.textContent=slot.label;select.name=slot.id;select.setAttribute('aria-label',slot.label);
      select.append(new Option('Empty','none'));
      for(const item of EQUIPMENT_ITEMS.filter(item=>item.slot===slot.id))select.append(new Option(item.name,item.id));
      select.addEventListener('change',()=>{
        const gear=world.equip(slot.id,select.value);
        for(const field of slots.querySelectorAll('select'))field.value=gear[field.name];
      });
      label.append(select);slots.append(label);
    }
  }
  const gear=world.getLoadout();
  for(const field of slots.querySelectorAll('select'))field.value=gear[field.name];
  $('pack-dialog').showModal();
}
$('pack').addEventListener('click',openPack);

async function post(path,body,session){
  const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session)headers.Authorization='Bearer '+session;
  const response=await fetch(path,{method:'POST',headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(Error(data.error||'The guild could not be reached.'),{status:response.status});
  return data;
}
async function startMedia(){
  if(!credentials?.media||mediaStarting||mediaActive)return;
  const ticket=++mediaEpoch,session=credentials.session;mediaStarting=true;$('retry-media').hidden=true;
  mediaStatus('Connecting voice and video…');
  try{
    const connection=await post('/api/media',undefined,session);
    if(ticket!==mediaEpoch)return;
    const connected=await media.connect(connection);
    if(ticket===mediaEpoch&&connected!==false){mediaActive=true;mediaStatus('');}
  }catch(error){if(ticket===mediaEpoch){mediaStatus(error.message||'Voice and video could not connect.');$('retry-media').hidden=false;}}
  finally{if(ticket===mediaEpoch)mediaStarting=false;}
}
function row(name,detail){
  const li=document.createElement('li'),pip=document.createElement('span'),label=document.createElement('span'),extra=document.createElement('small');
  pip.className='pip';pip.ariaHidden='true';label.textContent=name;label.title=name;extra.textContent=detail;
  li.append(pip,label,extra);return li;
}
function showWorld(message){
  if(!credentials||message.self!==credentials.id||!Array.isArray(message.peers))return;
  const me=message.peers.find(peer=>peer.id===message.self);if(!me)return;
  const opening=$('gate').hidden===false;
  world.sync(message);world.setActive(true);worldVisible(true);status('Connected','online');attempt=0;
  const peers=message.peers,agents=message.agents||[];
  nearby=nearbyIdentities(me,peers,nearby);media.setPositions(me,peers);
  const humans=peers.map(p=>[p.name,p.id===me.id?'You':nearby.has(p.id)?'Nearby':'In world']);
  const npcs=agents.map(a=>[a.chatTitle||a.name,[a.ownerName,({working:'Working',blocked:'Needs attention',error:'Needs attention'})[a.status]||'Idle'].filter(Boolean).join(' · '),a.id,a.hostAgent]);
  const stamp=JSON.stringify([humans,npcs]);
  if(stamp!==lastList){
    $('peer-count').textContent=peers.length;$('agent-count').textContent=agents.length;
    $('peer-list').replaceChildren(...humans.map(pair=>row(...pair)));
    $('agent-list').replaceChildren(...agents.map((agent,i)=>{
      const [name,detail]=npcs[i],li=row(name,detail);
      if(credentials.canOpenChats && agent.hostAgent !== false){
        const link=document.createElement('button');link.type='button';link.className='agent-chat';
        link.textContent=name;link.title='Open conversation in Herdr · '+agent.name;
        link.setAttribute('aria-label','Open conversation in Herdr: '+name);
        link.addEventListener('click',()=>herdr.chat(agent));
        li.children[1].replaceWith(link);
      }
      return li;
    }));$('agent-section').hidden=!agents.length;lastList=stamp;
  }
  if(opening){
    $('world').focus({preventScroll:true});
    if(credentials.media)void startMedia();
    else mediaStatus('Voice and video are unavailable in this guild.');
  }
}
async function leave(message='',notify=true){
  const old=credentials;credentials=null;sessionEpoch++;mediaEpoch++;clearTimeout(retryTimer);
  const previous=socket;socket=null;if(previous){previous.onclose=null;previous.close();}
  mediaStarting=false;mediaActive=false;nearby.clear();lastList='';remember(sessionKey,null);
  world.reset();worldVisible(false);$('join').disabled=false;status('At the gate','gate');$('gate-feedback').textContent=message;
  $('retry-media').hidden=true;mediaStatus('');await media.disconnect().catch(()=>{});
  if(notify&&old)await post('/api/leave',undefined,old.session).catch(()=>{});
}
function connectPresence(){
  if(!credentials)return;
  const epoch=sessionEpoch,wsURL=new URL('/presence',location.href);wsURL.protocol=location.protocol==='https:'?'wss:':'ws:';
  const ws=new WebSocket(wsURL);socket=ws;
  ws.onopen=()=>{if(epoch===sessionEpoch)ws.send(JSON.stringify({type:'hello',session:credentials.session}));};
  ws.onmessage=e=>{if(epoch!==sessionEpoch||ws!==socket)return;let msg;try{msg=JSON.parse(e.data);}catch{return;}
    if(msg.type==='world')showWorld(msg);
  };
  ws.onclose=e=>{
    if(epoch!==sessionEpoch||ws!==socket)return;world.setActive(false);media.setPositions(null,[]);nearby.clear();
    if(e.code===4001||(e.code===1000&&e.reason==='Session resumed elsewhere')){void leave('This adventurer continued in another tab. Enter again to join separately.',false);return;}
    if([1008,4003,4401,4403].includes(e.code)){void leave('Your guild session ended. Enter the guild again.',false);return;}
    status('Reconnecting…','waiting');
    if(!$('gate').hidden)$('gate-feedback').textContent='Reconnecting to the guild…';
    clearTimeout(retryTimer);retryTimer=setTimeout(connectPresence,Math.min(8000,400*(2**Math.min(attempt++,5))));
  };
}
$('join-form').addEventListener('submit',async event=>{
  event.preventDefault();if(joining||credentials)return;
  const name=$('name').value.trim(),code=invite||inviteFrom($('invite-code').value);
  if(!name||!code){$('gate-feedback').textContent='Enter your name and a guild invite.';return;}
  joining=true;$('join').disabled=true;$('gate-feedback').textContent='Entering the guild…';
  try{
    const joined=await post('/api/join',{name,invite:code,...(entry.owner&&code===entry.invite?{owner:entry.owner}:{})});invite=code;remember('runespace.team.name',name);
    credentials=joined;remember(sessionKey,JSON.stringify({credentials:joined,invite:code}));++sessionEpoch;
    const url=new URL(location.href);url.hash=new URLSearchParams({invite}).toString();history.replaceState(null,'',url);
    $('invite-field').hidden=true;connectPresence();
  }catch(error){
    $('gate-feedback').textContent=error.status===401||error.status===403?'This invite could not be accepted. Paste a new invite to try again.':error.message;
    if(error.status===401||error.status===403){invite='';$('invite-field').hidden=false;}
  }finally{joining=false;$('join').disabled=!!credentials;}
});
$('leave').addEventListener('click',()=>{void leave();});
$('controls').addEventListener('click',()=>$('help').showModal());
$('roster-toggle').addEventListener('click',()=>{
  const shown=$('roster').classList.toggle('expanded');$('roster-toggle').setAttribute('aria-expanded',String(shown));
});
$('invite').addEventListener('click',()=>{
  $('invite-link').value=teamInvite(new URL(location.href),invite);$('invite-dialog').showModal();$('invite-link').select();
});
$('copy-link').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText($('invite-link').value);$('invite-dialog').close();toast('Guild invite copied.');}
  catch{$('invite-link').focus();$('invite-link').select();toast('Select and copy the invite link.');}
});
$('retry-media').addEventListener('click',()=>{void startMedia();});
window.addEventListener('pagehide',()=>{if(socket){socket.onclose=null;socket.close();}void media.disconnect();});
window.addEventListener('pageshow',e=>{if(e.persisted&&credentials){mediaActive=false;connectPresence();if(credentials.media)void startMedia();}});
try{
  const previous=JSON.parse(saved(sessionKey)||'null');
  if(previous?.credentials?.session&&previous.invite===invite&&(!entry.hadOwner||previous.credentials.canOpenChats)){
    credentials=previous.credentials;++sessionEpoch;$('gate-feedback').textContent='Returning to the guild…';connectPresence();
  }
}catch{remember(sessionKey,null);}
